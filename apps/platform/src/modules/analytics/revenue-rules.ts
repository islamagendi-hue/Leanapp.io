/**
 * Which events carry revenue, and in which property. Pure, so it can be unit
 * tested and shown on the revenue page.
 *
 * Source of truth, in order:
 *   1. the app's published tracking plan: events marked revenue-relevant,
 *   2. the event catalog (implementation engine): events with `revenue: true`,
 *   3. any other track event with a numeric `revenue` property.
 * For a revenue event the amount is the first of `revenue`, `price`
 * (subscriptions), `fee` (money movement: your fee, not the transfer) that its
 * spec defines. An event whose spec has `refund_amount` is a refund and is
 * subtracted. Expected values (`value` on lead_qualified) and gross amounts
 * (`amount`, `gmv`) are not revenue. Amounts are in the event's `currency`.
 */
import { EVENT_LIBRARY } from "@/modules/implementation/catalog/events";
import { PROPERTY_SETS } from "@/modules/implementation/catalog/properties";

export interface RevenueRule {
  event: string;
  property: string;
  kind: "revenue" | "refund";
  source: "plan" | "catalog";
}

export const AMOUNT_PROPERTIES = ["revenue", "price", "fee"] as const;
export const REFUND_PROPERTY = "refund_amount";
/** Counted on any track event that has no rule of its own. */
export const FALLBACK_PROPERTY = "revenue";

export function ruleFor(event: string, properties: string[], source: RevenueRule["source"]): RevenueRule | null {
  if (properties.includes(REFUND_PROPERTY)) return { event, property: REFUND_PROPERTY, kind: "refund", source };
  const property = AMOUNT_PROPERTIES.find((p) => properties.includes(p));
  return property ? { event, property, kind: "revenue", source } : null;
}

export function catalogRules(): RevenueRule[] {
  const out: RevenueRule[] = [];
  for (const def of Object.values(EVENT_LIBRARY)) {
    if (!def.revenue || !def.properties) continue;
    const rule = ruleFor(def.name, (PROPERTY_SETS[def.properties] as { name: string }[]).map((p) => p.name), "catalog");
    if (rule) out.push(rule);
  }
  return out;
}

/** Catalog rules, overridden per event by the published plan's revenue-relevant events. */
export function revenueRules(planEvents: { name: string; properties: string[] }[] = []): RevenueRule[] {
  const byName = new Map(catalogRules().map((r) => [r.event, r]));
  for (const e of planEvents) {
    const rule = ruleFor(e.name, e.properties, "plan");
    if (rule) byName.set(e.name, rule);
  }
  return [...byName.values()].sort((a, b) => a.event.localeCompare(b.event));
}
