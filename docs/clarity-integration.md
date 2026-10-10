# Microsoft Clarity integration

Clarity keeps its session recordings and heatmaps. LeanApp does three separate things with it, each a capability with its own status in the Integrations Center (Settings → Integrations → Analytics and Event Sources → Microsoft Clarity, page `settings/integrations/microsoft_clarity`):

| Capability | Direction | What it does | Where it runs |
| --- | --- | --- | --- |
| `clarity_identity_bridge` | outbound | Tells Clarity's tag who the visitor is in LeanApp | the visitor's browser (web SDK) |
| `clarity_metrics_import` | inbound | Imports Clarity's aggregate metrics once a day | the scheduled worker |
| `clarity_profile_link` | outbound | Links user profiles to the Clarity project | the LeanApp UI |

Each one works on its own. The bridge needs no LeanApp connection. The import needs only the API token. The link needs only the project ID.

Code: `apps/platform/src/modules/integrations/clarity.ts` (API adapter and pure helpers), `clarity-service.ts` (database, RBAC, audit, worker), `sdks/javascript/src/clarity.ts` (bridge), migration `0042_clarity_insights.sql`.

## 1. Identity bridge (web SDK)

Opt-in:

```ts
Analytics.initialize({ apiKey: "la_pk_…", clarity: { enabled: true } });
```

When the bridge is on, the platform is `web`, `analytics` consent is granted and the page has Clarity's tag (`window.clarity` is a function), the SDK calls:

```js
clarity("identify", userId ?? anonymousId);            // LeanApp user id once identify() ran, else the anonymous id
clarity("set", "leanapp_anonymous_id", anonymousId);   // custom tag
```

It calls these once per identity: on start, after `identify()`, `alias()` and `reset()`, and when analytics consent is granted. Each event also checks, so a Clarity tag that loads after the SDK is picked up on the next call. Errors thrown by the tag are swallowed. When analytics consent is pending or denied, nothing is called. Granting it later sends the identity then.

The SDK **never** loads Clarity's script and never sends Clarity a consent signal. Withdrawing analytics consent stops further calls but can't remove what Clarity already received: that is between the site and Clarity.

### What the customer does

1. **Install Clarity's tag.** In Clarity: Settings → Setup → Get tracking code, and paste it in the page `<head>`. The `@microsoft/clarity` npm package also works ([Clarity setup](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup)). The tag must come before, or at the same time as, the LeanApp SDK. If it loads later, the next tracked event picks it up.
2. **Turn the bridge on** with `clarity: { enabled: true }`.
3. **Consent in the EEA, the UK and Switzerland.** From October 31, 2025, Clarity needs its own consent signal for visits from these regions ([Consent API v2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2)). The site's consent banner must send it, for example:
   ```js
   window.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
   ```
   LeanApp's `setConsent()` and Clarity's consent are separate. The site must set both.

Clarity's `identify` API takes the custom id as a string ([Clarity client API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api)). Clarity [documents](https://learn.microsoft.com/en-us/clarity/setup-and-installation/identify-api) that it hashes the custom id in the browser before sending it, and that the dashboard, recordings and heatmaps can be filtered by a custom user ID.

Status: shown as **Not verified** once a Clarity connection exists, else **Not configured**. The bridge runs between two scripts in the visitor's browser, so LeanApp's servers can't observe it. To check it, open a recording in Clarity and look for the `leanapp_anonymous_id` custom tag.

## 2. Metrics import (Data Export API)

**Request.** This follows Microsoft's [Data Export API documentation](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api), read on 2026-10-10:

```
GET https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1&dimension1=URL
Authorization: Bearer <token>
```

- `numOfDays` is 1, 2 or 3 (the last 24, 48 or 72 hours).
- `dimension1` to `dimension3` take one of `Browser`, `Device`, `Country/Region`, `OS`, `Source`, `Medium`, `Campaign`, `Channel`, `URL`.
- Clarity allows **10 requests per project per day**, at most 1,000 rows per response, and no paging.
- Clarity's documented errors are 400, 401, 403 and 429 ("Exceeded daily limit").

**What LeanApp asks for.** Each import makes three requests, one per dimension: `URL`, `Device` and `Source`, with `numOfDays=1` for scheduled runs and 1 to 3 days for **Import now**. LeanApp does not retry a failed request, because every attempt counts against the 10 a day. An import stops at the first failure, so a bad token costs one request. Rows imported before a failure are kept.

**Budget.** Each run reserves its 3 requests in `integration_sync_runs.requests` before sending anything. Its actual count is written when it finishes. An import starts only if `requests used today (UTC) + 3 ≤ 10`. The count covers every connection in the organization with the same Clarity project ID. An advisory lock per project serializes imports, so two can't both claim the last slots. A scheduled run that doesn't fit is moved to the next UTC day without calling Clarity. A manual run that doesn't fit is refused with a message. In practice this means at most 3 imports a day per project, and requests the customer makes with the same token outside LeanApp are not counted. If Clarity answers 429, the import waits until the next UTC day.

**Schedule.** `runClaritySyncJobs` runs in the worker (`GET /api/internal/process-events`, step `clarity_sync`, under the same time budget as the ad sync). It claims due capabilities with a 15-minute lease. After a success, the next run is set to 01:00 UTC the next day. Errors are handled like this:

| Error | Next run |
| --- | --- |
| auth (401 / 403) or missing settings | none, until a new token is saved |
| 429 | 01:00 UTC the next day |
| other errors | backoff of 15 min, 1 h, 6 h and so on, never later than the next daily run |

**Response parsing.** The response is parsed defensively. Microsoft publishes only a partial sample: a list of `{ metricName, information: [...] }` with Traffic fields `totalSessionCount`, `totalBotSessionCount`, `distantUserCount` (as strings) and `PagesPerSessionPercentage`, plus the dimension as a key. The parser:

- keeps every metric as named;
- keeps every numeric field, including numeric strings;
- takes the dimension value from the key named like the dimension, matched case-insensitively;
- drops the query string and fragment from URLs, because they can carry personal data;
- adds up duplicate rows;
- rejects a body that isn't a list.

**Not verified against the live API.** Field names other than Traffic's are not in Microsoft's sample. The UI shows, per metric, a preferred field when it is present, else the first numeric field, and names the field it shows:

| Metric | Preferred fields |
| --- | --- |
| Scroll Depth | `averageScrollDepth` |
| Engagement Time | `activeTime`, `totalTime` |
| click and behaviour metrics | `sessionsWithMetricPercentage`, `subTotal`, `sessionsCount` |

**Storage.** `platform.clarity_insights` holds one snapshot per connection, UTC day and dimension. The data covers `num_of_days × 24` hours before `period_end`. `dimension_value` is the dimension's value, `metric` is Clarity's `metricName`, and `metric_values` holds the numeric fields in jsonb. Re-importing on the same UTC day replaces that day's rows. The table is tenant-scoped with the standard RLS policy. Removing the connection deletes its rows. The rows contain no person-level data.

**Display.** The Clarity page shows the latest snapshot as a table per dimension (Page URL, Device, Source), labelled **Imported**, with its period, import time and freshness. It also shows "Sessions per import" (Traffic summed over devices), the request count for today and the import runs. Periods are Clarity's rolling 24 to 72 hours, so they can overlap. These are Clarity's numbers, not LeanApp's observed analytics.

**Credentials.** The token goes in `integration_connections.credentials_enc` as `{ "api_token": … }`. It is encrypted with AES-256-GCM under `INTEGRATIONS_ENCRYPTION_KEY` and bound to the row, and the tenant database role can't read it back. The project ID goes in `config.project_id` because it is not secret: it appears in the site's tag. Saving and changing the connection, toggling the import, Import now and removal are written to the audit log (`integration.connection_saved`, `integration.capability_updated`, `integration.sync_requested`, `integration.connection_removed`), and the token is never logged. Reading needs `integrations.read`. Changing needs `integrations.manage`.

## 3. Link from a user profile

When the environment's Clarity connection has a project ID, user profiles (Analytics → Users → profile) show **Open Microsoft Clarity**. The link goes to `https://clarity.microsoft.com/projects/view/<project id>/dashboard`, the project's Dashboard page. Clarity does not document this URL format: it is the address Clarity's web app uses (Clarity's documented demo uses `/demo/projects/view/<id>/…`). LeanApp does not build filtered-recording URLs, because Clarity documents no URL format for them. The profile says to filter recordings in Clarity by custom user ID (the LeanApp user ID, or the anonymous ID before identify) or by the custom tag `leanapp_anonymous_id` with the anonymous IDs shown. Reading the link needs `users.read`, the profile's own permission. The project ID must be 6 to 20 lowercase letters or digits. Anything else is refused and never linked.

## Simulated vs live

Every test is simulated:

- `src/modules/integrations/clarity.test.ts` covers the request shape, bearer header, no retry, error classes, defensive parsing, the budget, the schedule, the link format and capability status.
- `test/clarity.int.test.ts` covers encrypted storage, RBAC, import into the database, the 10-a-day budget, 401 / 429 / malformed answers, the worker, the profile link and tenant isolation, against a fake Clarity.
- `sdks/javascript/src/clarity.test.ts` covers the bridge: opt-in, consent, a tag loaded late, `reset`, and that it never sends a consent signal.

**Nothing has been run against a live Clarity project.** The import capability turns **Verified** only after a real import succeeds.

## Owner actions

1. Create (or pick) a Clarity project for the website at clarity.microsoft.com and install its tag on the site.
2. As a Clarity project admin: Settings → Data Export → **Generate new API token**. The name must be 4 to 32 characters: letters, digits, `-`, `_` or `.`. Paste the token and the project ID in LeanApp (Settings → Integrations → Microsoft Clarity), then **Turn on daily import**.
3. Live check: **Import now** once, and compare the Traffic sessions with Clarity's dashboard for the same 24 hours. Note which fields Clarity actually returns for Scroll Depth, Engagement Time and the click metrics. If they differ from the preferred names above, update `METRICS` in `clarity.ts` and this page, then remove the "not verified" notes.
4. Check that **Open Microsoft Clarity** on a profile opens the project dashboard. If Clarity changed its URLs, update `clarityProjectUrl`.
5. On the website: turn the bridge on (`clarity: { enabled: true }`), wire Clarity's Consent API (`consentv2`) into the consent banner for EEA, UK and Swiss visitors, and confirm a recording shows the `leanapp_anonymous_id` tag.
6. Keep `INTEGRATIONS_ENCRYPTION_KEY` set. No other environment variable is needed.
