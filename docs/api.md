# API

Base URL: `https://api.leanapp.io` (production). The dashboard is `https://app.leanapp.io`; both are served by the same deployment today. Machine-readable spec: [openapi.yaml](openapi.yaml).

## Authentication

| Surface | Credential | Header |
| --- | --- | --- |
| Ingestion from apps | Public SDK key `la_pk_…` | `Authorization: Bearer <key>` or `X-Api-Key: <key>` |
| Ingestion from servers | Secret key `la_sk_…` | same |
| Management API | Dashboard session cookie (`la_session`) | cookie; writes must be `Content-Type: application/json` |

Secret keys act on their environment within the permissions (scopes) chosen when the key is created: `events:write` (send events; the default), `privacy:read` (exports, consent lookups, listing suppressions) and `privacy:write` (deletions and their status, adding and removing suppressions). A key without the scope an endpoint needs gets `403 forbidden`. Secret-key access to the rest of the management API (for CI and infrastructure-as-code) is planned.

## Endpoints (built)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | Liveness, configuration check (variable names only) and database reachability; 503 when either fails |
| POST | `/v1/events` | key | Ingest one event (body is the event) |
| POST | `/v1/events/batch` | key | Ingest up to 500 events: `{ batch: [...], sent_at? }` |
| OPTIONS | `/v1/events`, `/v1/events/batch` | none | CORS preflight |
| GET | `/v1/organizations` | session | Organizations the user belongs to |
| GET | `/v1/organizations/{org}/apps` | session | Apps in an organization |
| POST | `/v1/organizations/{org}/apps` | session | Create an app (also creates 3 environments, keys and a tracking project) |
| GET | `/v1/organizations/{org}/environments/{env}/events?after={id}` | session | Debugger feed: newest events after an id, plus connection health |
| POST | `/v1/privacy/exports` | secret key, `privacy:read` | Everything stored about an end user, as JSON: `{ user_id?, anonymous_id? }` |
| POST | `/v1/privacy/deletions` | secret key, `privacy:write` | Delete an end user's data: `{ user_id?, anonymous_id? }` → `202 { id, status }` |
| GET | `/v1/privacy/deletions/{id}` | secret key, `privacy:write` | Deletion status, with rows deleted per table |
| GET | `/v1/privacy/consent?user_id=&anonymous_id=` | secret key, `privacy:read` | Current consent per purpose, consent history and suppressions of an end user |
| GET | `/v1/privacy/suppressions?channel=&user_id=&limit=&cursor=` | secret key, `privacy:read` | Suppression list, newest first, paged by `next_cursor` |
| POST | `/v1/privacy/suppressions` | secret key, `privacy:write` | Suppress a user: `{ user_id \| anonymous_id, channel \| channels, reason? }` → `201` |
| DELETE | `/v1/privacy/suppressions?user_id=&channel=` | secret key, `privacy:write` | Remove manual/API suppressions (`channel` repeatable) |
| GET | `/api/internal/process-events` | `Bearer $CRON_SECRET` | Internal: drain the processing queue and retry privacy deletions (Vercel Cron) |

Everything else in the dashboard (questionnaire, plans, keys, members) runs through server actions on top of the same modules. They become public REST endpoints as the management API grows (planned: plans, mappings, keys, members, and export).

## Ingestion semantics

- **Idempotency:** each event's `event_id` is unique per environment; duplicates count as `duplicates`, not errors. Send `Idempotency-Key` to make a whole request safely retryable; a replay returns the original response with `Idempotent-Replayed: true`.
- **Partial success:** batches return `200` with `accepted`, `duplicates`, `rejected[]` (by index) and `warnings[]`. A single event sent to `/v1/events` that fails validation returns `400` with the same body.
- **Errors:** `400 invalid_json | invalid_batch`, `401 invalid_api_key`, `403 forbidden` (secret key without `events:write`), `413 payload_too_large`, `429 rate_limited` (+ `Retry-After` seconds), `500`.
- **Limits:** see [events](events.md).
- `source` is set by the server: `backend` for secret keys, `mobile_sdk` for public keys.
- **Consent:** an event of `type: "consent"` with `consent: { analytics?, marketing?, push?, attribution? }` (booleans, at least one) records the user's decision instead of being stored as an event; it counts as accepted and is free. Events from a user or install whose latest analytics decision is "denied" (including a denial earlier in the same batch) are not stored and are listed in `rejected[]` with `reason: "consent_denied"`; a single event dropped this way still returns `200`. Where attribution is denied, `context.attribution` is removed. See [Consent](#consent-and-suppression).

## Privacy requests

Requests act on the secret key's environment only. Which rows belong to the subject:

- everything with the `user_id`;
- anonymous activity (no `user_id`) from the given `anonymous_id` and from installs linked to the `user_id`, as long as no other user is linked to the install. On a device shared between users that activity can't be attributed, so it is kept and the install is listed in `skipped_anonymous_ids` (in the export's `subject`, and in the deletion status). An `anonymous_id` sent without a `user_id` is taken as is;
- other users' identified activity is never touched, even on the same install.

Exports cover events, sessions, profile, installs, identity links, push tokens, attribution, consent, notifications, audience memberships and automation runs, up to 10,000 rows per table (`truncated` names any table that hit the limit). Deletions run as a job right after the `202`; the scheduled worker retries a failed or interrupted job up to 3 times. Both are rate-limited to 1,000 requests per hour per environment and recorded in the audit log. Owners and admins can do the same from the dashboard (app → Privacy requests).

Exports and deletions include consent history (`consent_records`), current consent (`consent_state`) and suppressions, following the same shared-device rule: a shared install's `anon:` entries are kept. Deleting a user also removes their suppressions; suppress them again if you keep their id in your own systems.

Deletion doesn't stop new data: stop sending events for the user first (for example `Analytics.reset()` in the SDK, and stop server-side events).

## Consent and suppression

**Recording consent.** The SDK's `setConsent()` sends a `consent` event (see [SDK](sdk.md#consent)); a server sends the same event with a secret key (`events:write`):

```json
{ "type": "consent", "user_id": "user_123", "event_id": "consent-user_123-42", "consent": { "marketing": false } }
```

Each purpose is appended to the history (`consent_records`, deduplicated by `event_id`) and becomes the current state when it is newer than what is stored (by the event's `timestamp`), so a late retry never overrides a newer decision.

**User keys and stitching.** Consent is kept per environment under user keys: the `user_id`, or `anon:<anonymous_id>` for an install. A change carrying both ids is stored under both. To decide about an event, the server looks at the event's user key and install key and takes the most recent decision. The SDK records the device's answers again when a user signs in (`identify`, `alias`) and after `reset()`, so consent given before login follows the user.

**Suppression lists.** Per environment, a user key can be suppressed on `marketing` (no marketing message on any medium), `push` or `email` (nothing on that medium). Sources: the dashboard (Privacy → Suppression list), the API, and consent: denying marketing or push adds an automatic `marketing` / `push` entry, and granting again removes only those automatic entries. Removing through the dashboard or API never removes an automatic entry while consent is denied (the response lists those in `still_suppressed_by_consent`). Adds and removals are in the audit log.

**For automation.** `src/modules/privacy/consent.ts` exports `isSuppressed(environmentId, userKey, channel)`, `suppressedKeys(...)` for batches and `consentState(environmentId, userKey)`; automation must call `isSuppressed` before each send.

## Errors

```json
{ "error": "validation_error", "message": "Human readable message", "details": {} }
```

| Status | `error` |
| --- | --- |
| 400 | `invalid_json`, `invalid_batch` |
| 401 | `unauthorized`, `invalid_api_key` |
| 403 | `forbidden` |
| 404 | `not_found` (also returned for organizations you are not a member of) |
| 409 | `conflict` |
| 413 | `payload_too_large` |
| 422 | `validation_error` |
| 429 | `rate_limited` |

## Versioning

Path-versioned (`/v1`). Additive changes (new fields, new endpoints) don't bump the version; clients must ignore unknown fields. Breaking changes ship as `/v2` with at least 12 months of overlap. The event wire format has its own `schema_version` per event.
