import { log } from "@/lib/log";
import { reconcileSubscriptions } from "@/modules/billing/reconcile";
import { billingStatus, verifyBillingProvider } from "@/modules/billing/status";
import { bearerMatches } from "@/server/internal-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Billing configuration status for the operator (docs/billing.md):
 * not_configured … ready_test / ready_live, the stored verification result,
 * the last signed webhook received and each plan price's state. Variable
 * names and provider ids only, never keys. Bearer MONITORING_SECRET
 * (read-only) or CRON_SECRET.
 */
export async function GET(req: Request) {
  if (!bearerMatches(req, process.env.MONITORING_SECRET, process.env.CRON_SECRET)) return new Response("Unauthorized", { status: 401 });
  return Response.json(await billingStatus(), { headers: noStore });
}

/**
 * Bearer CRON_SECRET. Body `{"action": "verify"}` runs the read-only provider
 * verification now (only when keys are configured) and returns the new
 * status; `{"action": "reconcile"}` re-reads every unfinished subscription
 * from the provider and applies it.
 */
export async function POST(req: Request) {
  if (!bearerMatches(req, process.env.CRON_SECRET)) return new Response("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === "verify") {
      const check = await verifyBillingProvider();
      return Response.json({ verified: Boolean(check), status: await billingStatus() }, { status: check ? 200 : 409, headers: noStore });
    }
    if (body?.action === "reconcile") {
      const report = await reconcileSubscriptions({ limit: 200 });
      return Response.json(report, { status: report.configured ? 200 : 409, headers: noStore });
    }
  } catch (err) {
    log.error("billing.internal_failed", { action: String(body?.action), error_name: err instanceof Error ? err.name : typeof err });
    return Response.json({ error: "provider_error" }, { status: 502, headers: noStore });
  }
  return Response.json({ error: "unknown_action", actions: ["verify", "reconcile"] }, { status: 400, headers: noStore });
}
