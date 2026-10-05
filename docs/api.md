# API

Base URL: `https://api.leanapp.io` (production). The dashboard is `https://app.leanapp.io`; both are served by the same deployment today. Machine-readable spec: [openapi.yaml](openapi.yaml).

## Authentication

| Surface | Credential | Header |
| --- | --- | --- |
| Ingestion from apps | Public SDK key `la_pk_…` | `Authorization: Bearer <key>` or `X-Api-Key: <key>` |
| Ingestion from servers | Secret key `la_sk_…` | same |
| Management API | Dashboard session cookie (`la_session`) | cookie; writes must be `Content-Type: application/json` |

Secret keys can ingest events and file privacy requests for their environment. Secret-key access to the rest of the management API (for CI and infrastructure-as-code) is planned.

## Endpoints (built)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | Liveness and database reachability |
| POST | `/v1/events` | key | Ingest one event (body is the event) |
| POST | `/v1/events/batch` | key | Ingest up to 500 events: `{ batch: [...], sent_at? }` |
| OPTIONS | `/v1/events`, `/v1/events/batch` | none | CORS preflight |
| GET | `/v1/organizations` | session | Organizations the user belongs to |
| GET | `/v1/organizations/{org}/apps` | session | Apps in an organization |
| POST | `/v1/organizations/{org}/apps` | session | Create an app (also creates 3 environments, keys and a tracking project) |
| GET | `/v1/organizations/{org}/environments/{env}/events?after={id}` | session | Debugger feed: newest events after an id, plus connection health |
| POST | `/v1/privacy/exports` | secret key | Everything stored about an end user, as JSON: `{ user_id?, anonymous_id? }` |
| POST | `/v1/privacy/deletions` | secret key | Delete an end user's data: `{ user_id?, anonymous_id? }` → `202 { id, status }` |
| GET | `/v1/privacy/deletions/{id}` | secret key | Deletion status, with rows deleted per table |
| GET | `/api/internal/process-events` | `Bearer $CRON_SECRET` | Internal: drain the processing queue and retry privacy deletions (Vercel Cron) |

Everything else in the dashboard (questionnaire, plans, keys, members) runs through server actions on top of the same modules. They become public REST endpoints as the management API grows (planned: plans, mappings, keys, members, and export).

## Ingestion semantics

- **Idempotency:** each event's `event_id` is unique per environment; duplicates count as `duplicates`, not errors. Send `Idempotency-Key` to make a whole request safely retryable; a replay returns the original response with `Idempotent-Replayed: true`.
- **Partial success:** batches return `200` with `accepted`, `duplicates`, `rejected[]` (by index) and `warnings[]`. A single event sent to `/v1/events` that fails validation returns `400` with the same body.
- **Errors:** `400 invalid_json | invalid_batch`, `401 invalid_api_key`, `413 payload_too_large`, `429 rate_limited` (+ `Retry-After` seconds), `500`.
- **Limits:** see [events](events.md).
- `source` is set by the server: `backend` for secret keys, `mobile_sdk` for public keys.

## Privacy requests

Requests act on the secret key's environment only. Which rows belong to the subject:

- everything with the `user_id`;
- anonymous activity (no `user_id`) from the given `anonymous_id`, and from installs linked to the `user_id` that no other user is linked to. On a device shared between users that activity can't be attributed, so it is kept;
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
| 403 | `forbidden` |
| 404 | `not_found` (also returned for organizations you are not a member of) |
| 409 | `conflict` |
| 413 | `payload_too_large` |
| 422 | `validation_error` |
| 429 | `rate_limited` |

## Versioning

Path-versioned (`/v1`). Additive changes (new fields, new endpoints) don't bump the version; clients must ignore unknown fields. Breaking changes ship as `/v2` with at least 12 months of overlap. The event wire format has its own `schema_version` per event.
