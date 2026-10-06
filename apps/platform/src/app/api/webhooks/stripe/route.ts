import { log } from "@/lib/log";
import { handleStripeWebhook } from "@/modules/billing/webhook";

export const runtime = "nodejs";

/**
 * Stripe webhook endpoint. Register https://<app host>/api/webhooks/stripe in
 * the Stripe dashboard with the events listed in docs/billing.md and put its
 * signing secret in STRIPE_WEBHOOK_SECRET. The body is read raw: the signature
 * covers the exact bytes Stripe sent.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
  try {
    const result = await handleStripeWebhook(raw, req.headers.get("stripe-signature"));
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    // 500 makes Stripe retry; the event id was rolled back with the failed transaction.
    log.error("stripe.webhook_failed", { error: err });
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
