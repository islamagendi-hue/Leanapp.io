import { log } from "@/lib/log";
import { handleTwilioWebhook } from "@/modules/twilio/service";
import { apiError } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 100_000;

/**
 * Twilio callback for one environment's Twilio integration: message status
 * callbacks (the StatusCallback LeanApp sets on every send) and inbound SMS /
 * WhatsApp messages (set as the sender's "A message comes in" webhook).
 * Form-encoded and signed with X-Twilio-Signature (HMAC-SHA1 with the auth
 * token over this exact URL and the sorted parameters). Answers with empty
 * TwiML so Twilio sends no automatic reply. See docs/messaging.md.
 */
export async function POST(req: Request, ctx: RouteContext<"/v1/twilio/webhook/[id]">) {
  try {
    const { id } = await ctx.params;
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const raw = await req.text();
    if (raw.length > MAX_BODY) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const r = await handleTwilioWebhook(id, raw, req.headers.get("x-twilio-signature"));
    if (r.applied) log.info("twilio.webhook", { integration_id: id, kind: r.kind });
    return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", { status: 200, headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
