/**
 * Growth definitions: what counts as activation, the core action, revenue and
 * a retained person for an app. Stored with the tracking plan version
 * (tracking_plan_versions.growth), so they are drafted, approved and published
 * with the plan. Pure (no database), so it is unit tested.
 */
import { z } from "zod";
import { msg } from "@/i18n/translate";
import { AMOUNT_PROPERTIES, ruleFor } from "@/modules/analytics/revenue-rules";
import { propertyFilterSchema, propertyName, type PropertyFilter } from "@/modules/analytics/sql";

/** Retention checkpoints: a person is retained on day N when they come back on calendar day N (analytics/retention-rule.ts). */
export const RETENTION_DAYS = [1, 7, 30] as const;

const eventName = z.string().trim().min(1, msg("Choose an event.")).max(200);

const eventRule = z.object({
  event: eventName,
  filters: z.array(propertyFilterSchema).max(5, msg("Up to 5 property conditions.")).default([]),
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

const NOT_IN_PLAN = {
  activation: msg('Activation: "{event}" is not in the tracking plan. Add it to the plan first.'),
  core_action: msg('Core action: "{event}" is not in the tracking plan. Add it to the plan first.'),
  revenue: msg('Revenue: "{event}" is not in the tracking plan. Add it to the plan first.'),
};
const RETENTION_NEEDS_CORE = msg("Retention counts returns by the core action, so choose a core action.");

/** Every problem message of growth definitions, for localize() where they're shown. */
export const DEFINITION_MESSAGES = [
  ...Object.values(NOT_IN_PLAN), RETENTION_NEEDS_CORE, msg("Choose an event."), msg("Up to 5 property conditions."),
  "Property names use letters, digits, _ . $ - (up to 64).",
];

/**
 * Checks a definition against the plan it is saved into: every event it names
 * must be in that plan version. Returns readable problems (empty = valid).
 */
export function definitionProblems(def: GrowthDefinition, planEvents: string[]): string[] {
  const inPlan = new Set(planEvents);
  const problems: string[] = [];
  const check = (problem: string, event: string | undefined) => {
    if (event && !inPlan.has(event)) problems.push(problem.replace("{event}", () => event));
  };
  check(NOT_IN_PLAN.activation, def.activation?.event);
  check(NOT_IN_PLAN.core_action, def.core_action?.event);
  check(NOT_IN_PLAN.revenue, def.revenue?.event);
  if (def.retention.return_event === "core_action" && !def.core_action) problems.push(RETENTION_NEEDS_CORE);
  return problems;
}

/** Suggested amount properties for a revenue event, in preference order. */
export function amountPropertyOptions(properties: string[]): string[] {
  const preferred = AMOUNT_PROPERTIES.filter((p) => properties.includes(p));
  return [...preferred, ...properties.filter((p) => !(preferred as string[]).includes(p))];
}

/**
 * Builds the raw definition from the setup form's flat fields (one property
 * condition per rule on the form; the stored format allows up to five).
 * Returns input for growthDefinitionSchema, so validation stays in one place.
 */
export function definitionInputFromFields(get: (key: string) => string | null | undefined): Record<string, unknown> {
  const v = (k: string) => (get(k) ?? "").trim();
  const rule = (prefix: string) => {
    if (!v(`${prefix}_event`)) return null;
    const name = v(`${prefix}_filter_name`);
    return {
      event: v(`${prefix}_event`),
      filters: name ? [{ name, op: v(`${prefix}_filter_op`) || "eq", value: v(`${prefix}_filter_value`) }] : [],
    };
  };
  return {
    activation: rule("act"),
    core_action: rule("core"),
    revenue: v("rev_event")
      ? { event: v("rev_event"), amount_property: v("rev_amount") || "revenue", currency_property: v("rev_currency") || "currency" }
      : null,
    retention: { return_event: v("return_event") === "core_action" ? "core_action" : "any" },
  };
}

/** The setup form's flat fields for a definition (inverse of definitionInputFromFields for one filter per rule). */
export function fieldsFromDefinition(def: GrowthDefinition): Record<string, string> {
  const out: Record<string, string> = { return_event: def.retention.return_event };
  for (const [prefix, rule] of [["act", def.activation], ["core", def.core_action]] as const) {
    if (!rule) continue;
    out[`${prefix}_event`] = rule.event;
    const f = rule.filters[0];
    if (f) Object.assign(out, { [`${prefix}_filter_name`]: f.name, [`${prefix}_filter_op`]: f.op, [`${prefix}_filter_value`]: f.value });
  }
  if (def.revenue) Object.assign(out, { rev_event: def.revenue.event, rev_amount: def.revenue.amount_property, rev_currency: def.revenue.currency_property });
  return out;
}
