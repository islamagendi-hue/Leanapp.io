import "server-only";
import { displayName } from "@/modules/implementation/plan-input";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { ANY_EVENT } from "./sql";

/** Event name → the name people read: the published tracking plan's display name, else "Order Completed" from order_completed. */
export type EventLabels = (name: string) => string;

/**
 * Display names for an app's events, for report pickers and tables. One small
 * query; the technical name stays the value everywhere (URLs, saved reports).
 */
export async function eventLabels(ctx: TenantContext, appId: string): Promise<EventLabels> {
  const rows = await tenantTx(ctx, "analytics.read", (db) =>
    db.query<{ event_name: string; display_name: string }>(
      `select e.event_name, e.display_name
         from platform.tracking_plans p
         join platform.tracking_events e on e.plan_version_id = p.published_version_id
        where p.app_id = $1`,
      [appId],
    ),
  );
  const known = new Map(rows.filter((r) => r.display_name?.trim()).map((r) => [r.event_name, r.display_name.trim()]));
  return (name) => (name === ANY_EVENT ? "Any event" : known.get(name) ?? displayName(name));
}

/** The published plan's events with their display names, for quick search. Empty without a plan. */
export async function planEventList(ctx: TenantContext, appId: string): Promise<{ name: string; label: string }[]> {
  const rows = await tenantTx(ctx, "analytics.read", (db) =>
    db.query<{ event_name: string; display_name: string }>(
      `select e.event_name, e.display_name
         from platform.tracking_plans p
         join platform.tracking_events e on e.plan_version_id = p.published_version_id
        where p.app_id = $1
        order by e.sort_order`,
      [appId],
    ),
  );
  return rows.map((r) => ({ name: r.event_name, label: r.display_name?.trim() || displayName(r.event_name) }));
}
