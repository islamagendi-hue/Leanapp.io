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
| `type` | `track` (default), `screen`, `identify`, `alias`, `push_token` |
| `event_name` | Required for `track`. Starts with a letter; letters, digits, space `_ . : -`; ≤100 chars. Plans use `snake_case` `object_action` (`order_completed`). |
| `event_id` | Strongly recommended. Unique per environment; duplicates are ignored. Missing ids get a server id and a warning. |
| `anonymous_id` / `user_id` | At least one required |
| `timestamp` | ISO 8601. > 31 days old: rejected. > 10 min in the future: replaced with receive time. Corrected by `sent_at` skew. |
| `properties` | ≤255 keys, ≤32KB, nesting depth ≤4 |
| whole event | ≤64KB; batch ≤1MB |

System types map to stored names: `screen` → `screen_viewed`, `identify` → `user_identified`, `alias` → `user_aliased`, `push_token` → `push_token_registered`.

## Response

```json
{ "batch_id": "…", "accepted": 4, "duplicates": 1, "rejected": [ { "index": 2, "event_id": "…", "errors": [ { "field": "timestamp", "message": "…" } ] } ], "warnings": [] }
```

Partial success is normal: valid events are stored, invalid ones are listed by index. A request with the same `Idempotency-Key` returns the stored response with `Idempotent-Replayed: true`.

## Naming conventions

- `snake_case`, past tense, object first: `product_viewed`, `checkout_started`, `order_completed`, `subscription_renewed`.
- One event per business fact; variations go in properties (`payment_method`, `source`), not new event names.
- Money: a number in `revenue`/`value`/`price` plus an ISO 4217 `currency`. Refunds are their own event (`refund_completed`), never negative revenue.
- User properties describe the person (`city`, `plan`, `language`). Actions (`last_order_value`, `cart_items`) belong in event properties; the validator warns about volatile user properties.

## Lifecycle

Received → processed (identity, session) → validated against the published plan → counted in `tracking_implementation_status` (received / valid / invalid / sources) → visible in the debugger and validation views. Events not in the plan are kept and listed as *unplanned*, with mapping suggestions when they look like a planned event.

## Standard library

The engine's catalogue (`apps/platform/src/modules/implementation/catalog/events.ts`) defines 84 standard events in 19 categories (lifecycle, account, onboarding, discovery, commerce, revenue, subscription, fulfilment, marketplace, booking, fintech, learning, health, gaming, social, engagement, growth, messaging, lead), each with properties, priority, source (app, backend, both) and the reason to track it. See [tracking plan](tracking-plan.md).
