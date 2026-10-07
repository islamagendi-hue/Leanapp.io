/**
 * Growth definitions: what counts as activation, the core action, revenue and
 * a retained person for an app. Stored with the tracking plan version
 * (tracking_plan_versions.growth), so they are drafted, approved and published
 * with the plan. Pure (no database), so it is unit tested.
 */
import { z } from "zod";
import { AMOUNT_PROPERTIES, ruleFor } from "@/modules/analytics/revenue-rules";
import { propertyFilterSchema, propertyName, type PropertyFilter } from "@/modules/analytics/sql";

/** Retention checkpoints: a person is retained on day N when they come back on or after day N. */
export const RETENTION_DAYS = [1, 7, 30] as const;

const eventName = z.string().trim().min(1, "Choose an event.").max(200);

const eventRule = z.object({
  event: eventName,
  filters: z.array(propertyFilterSchema).max(5, "Up to 5 property conditions.").default([]),
});

export const growthDefinitionSchema = z.object({
  activation: eventRule.nullable().default(null),
  core_action: eventRule.nullable().default(null),
  revenue: z
    .object({
      event: eventName,
      amount_property: propertyName,
      currency_property: propertyName.default("currency"),
    })
    .nullable()
    .default(null),
  retention: z.object({ return_event: z.enum(["any", "core_action"]).default("any") }).default({ return_event: "any" }),
});

export type GrowthDefinition = z.output<typeof growthDefinitionSchema>;
export type EventRule = { event: string; filters: PropertyFilter[] };

export interface PlanVersionGrowthSource {
  growth: unknown;
  activation_event: string | null;
  north_star_event: string | null;
}

export interface PlanEventForGrowth {
  event_name: string;
  revenue_relevance: boolean;
  properties: { name: string }[];
}

/**
 * The definition a plan version stands for. A version with saved growth
 * definitions uses them. One without (every version made before Phase 1)
 * derives them: activation = the plan's activation event, core action = its
 * north-star event, revenue = its first revenue-relevant event with an amount
 * property (revenue, price, fee), in its `currency` property. Saved data that
 * no longer validates falls back to the derived definition rather than failing.
 */
export function effectiveDefinition(version: PlanVersionGrowthSource | null, events: PlanEventForGrowth[] = []): GrowthDefinition {
  if (version?.growth) {
    const saved = growthDefinitionSchema.safeParse(version.growth);
    if (saved.success) return saved.data;
  }
  return derivedDefinition(version, events);
}

export function derivedDefinition(version: Pick<PlanVersionGrowthSource, "activation_event" | "north_star_event"> | null, events: PlanEventForGrowth[] = []): GrowthDefinition {
  let revenue: GrowthDefinition["revenue"] = null;
  for (const e of events) {
    if (!e.revenue_relevance) continue;
    const rule = ruleFor(e.event_name, e.properties.map((p) => p.name), "plan");
    if (rule?.kind === "revenue") {
      revenue = { event: e.event_name, amount_property: rule.property, currency_property: "currency" };
      break;
    }
  }
  return {
    activation: version?.activation_event ? { event: version.activation_event, filters: [] } : null,
    core_action: version?.north_star_event ? { event: version.north_star_event, filters: [] } : null,
    revenue,
    retention: { return_event: "any" },
  };
}

/**
 * Checks a definition against the plan it is saved into: every event it names
 * must be in that plan version. Returns readable problems (empty = valid).
 */
export function definitionProblems(def: GrowthDefinition, planEvents: string[]): string[] {
  const inPlan = new Set(planEvents);
  const problems: string[] = [];
  const check = (label: string, event: string | undefined) => {
    if (event && !inPlan.has(event)) problems.push(`${label}: "${event}" is not in the tracking plan. Add it to the plan first.`);
  };
  check("Activation", def.activation?.event);
  check("Core action", def.core_action?.event);
  check("Revenue", def.revenue?.event);
  if (def.retention.return_event === "core_action" && !def.core_action) problems.push("Retention counts returns by the core action, so choose a core action.");
  return problems;
}

/** Suggested amount properties for a revenue event, in preference order. */
export function amountPropertyOptions(properties: string[]): string[] {
  const preferred = AMOUNT_PROPERTIES.filter((p) => properties.includes(p));
  return [...preferred, ...properties.filter((p) => !(preferred as string[]).includes(p))];
}
