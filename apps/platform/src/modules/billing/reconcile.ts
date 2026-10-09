import "server-only";
/**
 * Reconciliation: asks the provider for the current state of every
 * subscription that isn't finished yet and applies it, so a webhook that never
 * arrived (endpoint down past Stripe's retry window, a secret rolled
 * mid-delivery) can't leave an organization on the wrong plan. Runs only when
 * payments are configured; read-only towards the provider.
 *
 * The provider's object is applied as of now, through the same code as a
 * webhook (webhook.ts applySubscription), so ordering and terminal-state
 * rules are identical. A subscription the provider no longer has is applied
 * as cancelled.
 */
import { withSystem } from "@/lib/db";
import { log } from "@/lib/log";
import { billingProvider } from "./provider";
import { applySubscription, TERMINAL } from "./webhook";

export interface ReconcileReport {
  configured: boolean;
  checked: number;
  applied: number;
  unchanged: number;
  failed: number;
}

export async function reconcileSubscriptions(opts: { limit?: number; env?: Record<string, string | undefined> } = {}): Promise<ReconcileReport> {
  const provider = billingProvider(opts.env);
  const report: ReconcileReport = { configured: Boolean(provider), checked: 0, applied: 0, unchanged: 0, failed: 0 };
  if (!provider) return report;
  const rows = await withSystem((db) =>
    db.query<{ provider_subscription_id: string }>(
      `select provider_subscription_id from platform.subscriptions
        where provider = 'stripe' and provider_subscription_id is not null and status <> all($1)
          and (livemode is null or livemode = $2)
        order by updated_at asc limit $3`,
      [TERMINAL, provider.mode === "live", Math.min(Math.max(opts.limit ?? 100, 1), 1000)],
    ),
  );
  for (const r of rows) {
    report.checked++;
    try {
      const remote = await provider.getSubscription(r.provider_subscription_id);
      const now = Math.floor(Date.now() / 1000);
      const object = remote ?? { id: r.provider_subscription_id, status: "canceled" };
      const result = await withSystem(async (db) => {
        if (!remote) {
          // Gone from the provider: keep what we know about it and mark it cancelled.
          const known = await db.one<{ organization_id: string; provider_customer_id: string | null; provider_price_id: string | null }>(
            "select organization_id, provider_customer_id, provider_price_id from platform.subscriptions where provider = 'stripe' and provider_subscription_id = $1",
            [r.provider_subscription_id],
          );
          Object.assign(object, {
            customer: known?.provider_customer_id, metadata: { organization_id: known?.organization_id },
            items: { data: [{ price: { id: known?.provider_price_id } }] },
          });
        }
        return applySubscription(db, { type: "reconcile", created: now }, object, provider.mode);
      });
      if (result.outcome === "applied") report.applied++;
      else report.unchanged++;
    } catch (err) {
      report.failed++;
      log.warn("billing.reconcile_failed", { subscription: r.provider_subscription_id, error_name: err instanceof Error ? err.name : typeof err });
    }
  }
  log.info("billing.reconciled", { ...report });
  return report;
}
