# Webhooks

**Status: built (Phase 4).**

- **Code:** `apps/platform/src/modules/webhooks`.
- **Tables:** `webhooks`, `webhook_deliveries`.
- **Permission:** `webhooks.manage`. Automations can pick a webhook with `automations.read`.
- **Dashboard:** app → Developers → Webhooks.

Webhooks are per environment.

## Event types

| Type | Sent when |
| --- | --- |
| `audience.entered` / `audience.exited` | A user enters or leaves an active [audience](audiences.md). The baseline taken at activation isn't sent. |
| `automation.webhook` | An [automation](automation.md) reaches a webhook step. The webhook receives this type whatever it subscribes to. |
| `webhook.test` | The **Send test** button |

## Payload

```json
{
  "id": "6c0e…",
  "type": "audience.entered",
  "created_at": "2026-10-06T09:00:00Z",
  "data": {
    "audience": { "id": "…", "name": "Cart abandoners" },
    "user_key": "user_123",
    "user_id": "user_123",
    "anonymous_id": null
  }
}
```

The `data` of an `automation.webhook` delivery has `automation` (`id`, `name`, `version`), `run_id`, `step`, `user_key`, `user_id`, `anonymous_id` and `trigger` (the trigger event's name, id, timestamp and properties, or the audience transition). Payloads include identifiers only; user profile properties aren't sent.

## Headers and signature

| Header | Value |
| --- | --- |
| `LeanApp-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` |
| `LeanApp-Event` | Event type |
| `LeanApp-Delivery` | Delivery id; the same on every retry |
| `Idempotency-Key` | Stable per logical event; use it to de-duplicate |

To verify a delivery:

1. Compute the HMAC over the **raw** request body.
2. Compare it with `v1` in constant time.
3. Reject timestamps more than 5 minutes from your clock.

```js
import crypto from "node:crypto";
function verify(secret, header, rawBody) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

## Signing secret

The secret (`whsec_…`) is shown once, when the webhook is created or the secret is rotated. Rotating it invalidates the old secret immediately.

LeanApp has to keep the secret to sign deliveries, so it's stored two ways:

- AES-256-GCM encrypted with `INTEGRATIONS_ENCRYPTION_KEY`, bound to the webhook row;
- as a SHA-256 hash with a display prefix.

Without the key, webhooks can't be created and deliveries stay queued (`secret_unavailable`). The secret is never logged.

## Delivery and retries

- The scheduled worker sends due deliveries every 5 minutes. It claims them with `for update skip locked` and a lease.
- **Success:** any `2xx` within 10 s. Redirects aren't followed.
- **Retries:** after any other result, with exponential backoff: 1 min × 2^(attempt−1), capped at 6 h, plus up to 10% jitter.
- **Giving up:** after 10 attempts the delivery is marked `giving_up`.
- **Manual actions:** **Send test** sends immediately and shows the result. **Retry** re-queues a delivery that failed or gave up.
- **Delivery log:** shows the status, attempts, HTTP code, duration, error and the first 500 bytes of the response.
- **Disabled webhook:** its deliveries fail with `webhook_disabled`.
- **Cleanup:** deliveries that are no longer pending are purged after 30 days.

## Network safety

Webhook URLs must be `https` on deployed environments. Every connection resolves DNS through a filter that blocks private, loopback, link-local (including the cloud metadata address), CGNAT and multicast addresses, also when a public name resolves to one.

A local deployment (or `WEBHOOK_ALLOW_PRIVATE_NETWORKS=1`) allows `http://localhost` receivers, so you can test against a local server.
