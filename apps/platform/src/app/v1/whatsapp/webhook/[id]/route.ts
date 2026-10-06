import { log } from "@/lib/log";
import { handleWebhook, verifySubscription } from "@/modules/whatsapp/service";
import { apiError } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 1_000_000;

/**
 * Meta WhatsApp Cloud API webhook for one environment's WhatsApp integration
 * (the URL shown on Engage → Integrations). GET is Meta's verify-token
 * handshake; POST carries delivery statuses and inbound messages, signed with
 * the app secret (X-Hub-Signature-256). See docs/messaging.md.
 */
export async function GET(req: Request, ctx: RouteContext<"/v1/whatsapp/webhook/[id]">) {
  const { id } = await ctx.params;
  const challenge = await verifySubscription(id, new URL(req.url).searchParams);
  if (challenge === null) return new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain" } });
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

export async function POST(req: Request, ctx: RouteContext<"/v1/whatsapp/webhook/[id]">) {
  try {
    const { id } = await ctx.params;
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const raw = await req.text();
    if (raw.length > MAX_BODY) return Response.json({ error: "payload_too_large" }, { status: 413 });
    const r = await handleWebhook(id, raw, req.headers.get("x-hub-signature-256"));
    if (r.statuses || r.optOuts) log.info("whatsapp.webhook", { integration_id: id, statuses: r.statuses, opt_outs: r.optOuts });
    return Response.json({ received: true, ...r });
  } catch (err) {
    return apiError(err);
  }
}
