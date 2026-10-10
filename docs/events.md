# Events

## Wire format

`POST /v1/events` (one event) or `POST /v1/events/batch` (`{ "batch": [ … ], "sent_at": "…" }`, up to 500).

```json
{
  "type": "track",
  "event_name": "order_completed",
  "event_id": "o-1029",
  "timestamp": "2026-10-05T10:00:00Z",
  "anonymous_id": "6f1c…",
  "user_id": "u-42",
  "session_id": "b2a9…",
  "properties": { "order_id": "o-1029", "revenue": 120, "currency": "SAR" },
  "user_properties": { "city": "Riyadh" },
  "context": {
    "platform": "ios", "app_version": "2.4.0", "os_version": "18.1",
    "sdk": { "name": "leanapp-js", "version": "0.1.0" },
    "locale": "ar-SA", "timezone": "Asia/Riyadh",
    "attribution": { "utm_source": "tiktok", "ttclid": "…" }
  }
}
```

| Field | Rules |
| --- | --- |
| `type` | `track` (default), `screen`, `identify`, `alias`, `push_token`, `consent` |
| `consent` | Required for `consent`: `{ analytics?, marketing?, push?, attribution? }` booleans, at least one. Recorded as the user's consent ([API](api.md#consent-and-suppression)), not stored as an event |
| `event_name` | Required for `track`. Starts with a letter; letters, digits, space `_ . : -`; ≤100 chars. Plans use `snake_case` `object_action` (`order_completed`). |
| `event_id` | Strongly recommended. Unique per environment; duplicates are ignored. Missing ids get a server id and a warning. |
| `anonymous_id` / `user_id` | At least one required |
| `timestamp` | ISO 8601. > 31 days old: rejected. > 10 min in the future: replaced with receive time. Corrected by `sent_at` skew. |
| `properties` | ≤255 keys, ≤32KB, nesting depth ≤4 |
| whole event | ≤64KB; batch ≤1MB |
| `context.attribution` | String map; see [below](#contextattribution) |
| `context.user_agent` | ≤1,000 chars. The web SDK sends `navigator.userAgent` |
| `context.consent` | `{ purpose: boolean }`: the purposes the user has answered, sent by the SDKs on every event (never the defaults) |

### context.attribution

Optional, backward compatible: any string key (1–60 chars, ≤64 keys) with a string value ≤1,000 chars is still accepted. The well-known keys are typed in `apps/platform/src/modules/ingestion/attribution-context.ts`, which the attribution engine reads through `attributionEvidence()`:

| Keys | Meaning |
| --- | --- |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` | Campaign labels |
| `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `ScCid` (or `sccid`), `twclid`, `li_fat_id`, `msclkid`, `click_id` | Ad network click ids; `click_id` is LeanApp's own |
| `campaign_id`, `adset_id`, `ad_id` | Ad network ids from URL macros |
| `landing_url`, `referrer` | Web: the page the visit started on and the external referrer. Must be `http(s)` URLs, else dropped with a warning |
| `touch` | Web: `first` or `latest`; any other value is dropped with a warning |
| `deep_link_url` | Native SDKs: the URL that opened the app |
| `fbp`, `fbc` | Web: Meta's browser ids from the `_fbp` / `_fbc` cookies (sent only with marketing consent) |
| `ttp`, `scid` | Web: TikTok's `_ttp` and Snap's `_scid` cookie values, set by their pixels (sent only with marketing consent; never set by LeanApp) |
| `adservices_token` | iOS: Apple's AdServices attribution token, on `app_installed`; ≤4,096 chars |

The web SDK sends a `landing_viewed` track event (`properties.landing_url`, `referrer`) when a visit starts from a campaign or an external referrer, with the touch in `context.attribution`. A direct visit sends no `landing_viewed`, and its first event carries only `landing_url`. See [SDKs](sdk.md#web-attribution).

System types map to stored names: `screen` → `screen_viewed`, `identify` → `user_identified`, `alias` → `user_aliased`, `push_token` → `push_token_registered`. `consent` events are not stored as events.

Events from a user whose latest analytics decision is "denied" are rejected with `"reason": "consent_denied"` (not stored, not billed).

Events of a user deleted by a privacy request (their `user_id`, or a deleted install's anonymous events) are rejected with `"reason": "subject_deleted"` (not stored, not billed). See [API](api.md#privacy-requests).

## Response

```json
{ "batch_id": "…", "accepted": 4, "duplicates": 1, "rejected": [ { "index": 2, "event_id": "…", "errors": [ { "field": "timestamp", "message": "…" } ] } ], "warnings": [] }
```

Partial success is normal: valid events are stored, invalid ones are listed by index. A request with the same `Idempotency-Key` and the same events (same `event_id`s, same order) returns the stored response with `Idempotent-Replayed: true`; the same key with different events returns `409 idempotency_key_reused` and stores nothing.

## Naming conventions

- `snake_case`, past tense, object first: `product_viewed`, `checkout_started`, `order_completed`, `subscription_renewed`.
- One event per business fact; variations go in properties (`payment_method`, `source`), not new event names.
- Money: a number in `revenue`/`value`/`price` plus an ISO 4217 `currency`. Refunds are their own event (`refund_completed`), never negative revenue.
- User properties describe the person (`city`, `plan`, `language`). Actions (`last_order_value`, `cart_items`) belong in event properties; the validator warns about volatile user properties.

## Lifecycle

Received → processed (identity, session) → validated against the published plan → counted in `tracking_implementation_status` (received / valid / invalid / sources) → visible in the debugger and validation views. Events not in the plan are kept and listed as *unplanned*, with mapping suggestions when they look like a planned event.

## Standard library

The engine's catalogue (`apps/platform/src/modules/implementation/catalog/events.ts`) defines 84 standard events in 19 categories (lifecycle, account, onboarding, discovery, commerce, revenue, subscription, fulfilment, marketplace, booking, fintech, learning, health, gaming, social, engagement, growth, messaging, lead), each with properties, priority, source (app, backend, both) and the reason to track it. See [tracking plan](tracking-plan.md).
