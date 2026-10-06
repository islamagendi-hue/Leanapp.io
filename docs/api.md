# API

Base URL: `https://api.leanapp.io` (production). The dashboard is `https://app.leanapp.io`; both are served by the same deployment today. Machine-readable spec: [openapi.yaml](openapi.yaml).

## Authentication

| Surface | Credential | Header |
| --- | --- | --- |
| Ingestion from apps | Public SDK key `la_pk_…` | `Authorization: Bearer <key>` or `X-Api-Key: <key>` |
| Ingestion from servers | Secret key `la_sk_…` | same |
| Management API (dashboard) | Dashboard session cookie (`la_session`) | cookie; writes must be `Content-Type: application/json` |
| Management API (servers, CI) | Secret key `la_sk_…` with a management scope | `Authorization: Bearer <key>` or `X-Api-Key: <key>` |

Secret keys act on their environment within the permissions (scopes) chosen when the key is created (app → SDK & API keys):

| Scope | Allows |
| --- | --- |
| `events:write` | Send events (the default) |
| `privacy:read` | Privacy exports |
| `privacy:write` | Privacy deletions and their status |
| `management:read` | Read the key's app, its environment and the published tracking plan |
| `plan:write` | Add custom events to the draft tracking plan (never publishes) |
| `analytics:read` | Events report and event trend of the key's environment |
| `users:read` | Look up an end user of the key's environment by `user_id` |

A key without the scope an endpoint needs gets `403 forbidden`; a public SDK key gets `403` on every secret-key endpoint. The database constraint `api_keys_scopes_known` (migrations 0007, 0011) and `API_KEY_SCOPES` in `modules/credentials/service.ts` hold the same list.

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
| GET | `/v1/app` | secret key, `management:read` | The key's app with the key's environment (other environments are not listed) |
| GET | `/v1/environment` | secret key, `management:read` | The key's environment |
| GET | `/v1/tracking-plan` | secret key, `management:read` | The published tracking plan (`leanapp.tracking_plan/v1` JSON, same as the dashboard export); 404 until one is published |
| POST | `/v1/tracking-plan/events` | secret key, `plan:write` | Add a custom event to the draft plan → `201 { version_id, version, status: "draft", draft_created, event_name, warnings }` |
| GET | `/v1/analytics/events?days=7\|30\|90` | secret key, `analytics:read` | Events with count and distinct people, most frequent first |
| GET | `/v1/analytics/trend?event=&days=&breakdown=` | secret key, `analytics:read` | Daily counts and people for one event, optional breakdown (`platform`, `app_version`, `country`, `property:<name>`) |
| GET | `/v1/users/{user_id}` | secret key, `users:read` | An end user of the key's environment: properties, first/last seen, linked installs, event count |
| GET | `/api/internal/process-events` | `Bearer $CRON_SECRET` | Internal: drain the processing queue, retry privacy deletions, send plan usage notices (Vercel Cron) |
| POST | `/api/webhooks/stripe` | `Stripe-Signature` | Stripe webhooks (see [billing](billing.md)); `503` until payments are configured, `400 invalid_signature` on a bad or stale signature |

Everything else in the dashboard (questionnaire, plan editing, approval and publishing, keys, members) runs through server actions on top of the same modules. The dashboard also serves `GET /o/{org}/apps/{app}/implementation/plan/export?version=&format=json|csv` (session cookie) for plan downloads. Planned for the secret-key API: editing and removing plan events and properties, mappings, funnels and retention, keys and members.

## Management API (secret keys)

- **Scoping.** A secret key belongs to one environment of one app. Every endpoint answers for that app and environment only: a development key never sees production events or users, and other environments of the app are not even listed. Organization isolation is enforced by Postgres RLS underneath.
- **Tracking plan.** The plan is per app, so a key of any environment reads the same published plan. `POST /v1/tracking-plan/events` writes to the plan's working draft (copying the newest approved or published version into a new draft when there is none, or starting an empty plan when the app has none). It never publishes: a person approves and publishes in the dashboard, and the published version keeps validating events until then. Requests are recorded in the audit log as `api_key` actions with the key id.
- **Analytics.** The same functions and numbers as the dashboard reports (canonical names after mappings, track events only, the app's timezone, 15 s statement timeout).
- **Rate limit.** 600 requests per minute per environment (env `MANAGEMENT_API_REQUESTS_PER_MINUTE`), shared by all management endpoints; `429` with `Retry-After` beyond it.
- **Logs.** Every request with a recognised key (including `403` and `429`) is written to `api_request_logs` with the route template (`GET /v1/users/{user_id}`, never the id), status, duration, key kind and error code.

## Ingestion semantics

- **Idempotency:** each event's `event_id` is unique per environment; duplicates count as `duplicates`, not errors. Send `Idempotency-Key` to make a whole request safely retryable; a replay returns the original response with `Idempotent-Replayed: true`.
- **Partial success:** batches return `200` with `accepted`, `duplicates`, `rejected[]` (by index) and `warnings[]`. A single event sent to `/v1/events` that fails validation returns `400` with the same body.
- **Errors:** `400 invalid_json | invalid_batch`, `401 invalid_api_key`, `403 forbidden` (secret key without `events:write`), `413 payload_too_large`, `429 rate_limited` (+ `Retry-After` seconds), `429 plan_limit_exceeded` (the organization used its monthly event allowance plus the 10% grace; + `Retry-After`; nothing in the request is stored, retry later), `500`.
- **Plan allowance:** past 100% of the monthly allowance (inside the grace) responses carry `X-LeanApp-Plan-Limit: grace`. See [billing](billing.md).
- **Limits:** see [events](events.md).
- `source` is set by the server: `backend` for secret keys, `mobile_sdk` for public keys.

## Privacy requests

Requests act on the secret key's environment only. Which rows belong to the subject:

- everything with the `user_id`;
- anonymous activity (no `user_id`) from the given `anonymous_id` and from installs linked to the `user_id`, as long as no other user is linked to the install. On a device shared between users that activity can't be attributed, so it is kept and the install is listed in `skipped_anonymous_ids` (in the export's `subject`, and in the deletion status). An `anonymous_id` sent without a `user_id` is taken as is;
- other users' identified activity is never touched, even on the same install.

Exports cover events, sessions, profile, installs, identity links, push tokens, attribution, consent, notifications, audience memberships and automation runs, up to 10,000 rows per table (`truncated` names any table that hit the limit). Deletions run as a job right after the `202`; the scheduled worker retries a failed or interrupted job up to 3 times. Both are rate-limited to 1,000 requests per hour per environment and recorded in the audit log. Owners and admins can do the same from the dashboard (app → Privacy requests).

Deletion doesn't stop new data: stop sending events for the user first (for example `Analytics.reset()` in the SDK, and stop server-side events).

## Errors

```json
{ "error": "validation_error", "message": "Human readable message", "details": {} }
```

| Status | `error` |
| --- | --- |
| 400 | `invalid_json`, `invalid_batch` |
| 401 | `unauthorized`, `invalid_api_key` |
| 403 | `forbidden`, `plan_limit_exceeded` (creating an app or inviting a member beyond the plan) |
| 404 | `not_found` (also returned for organizations you are not a member of) |
| 409 | `conflict` (e.g. the event is already in the draft) |
| 413 | `payload_too_large` |
| 422 | `validation_error` (also invalid JSON on management endpoints) |
| 429 | `rate_limited`, `plan_limit_exceeded` (ingestion past the monthly allowance and grace) |

## Versioning

Path-versioned (`/v1`). Additive changes (new fields, new endpoints) don't bump the version; clients must ignore unknown fields. Breaking changes ship as `/v2` with at least 12 months of overlap. The event wire format has its own `schema_version` per event.
