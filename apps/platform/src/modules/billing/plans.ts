/**
 * Plan catalog rules. Pure: no database, no network, no clock.
 *
 * Plans, prices shown to customers, limits and entitlements are data
 * (platform.plans, platform.plan_features). Provider price ids are
 * configuration, never data or code: one environment variable per plan and
 * interval, `STRIPE_PRICE_<PLAN>_<INTERVAL>` (e.g. STRIPE_PRICE_STARTER_MONTHLY,
 * STRIPE_PRICE_GROWTH_ANNUAL), filled in once the Stripe products exist.
 */

export type BillingInterval = "month" | "year";
export const INTERVALS: readonly BillingInterval[] = ["month", "year"];
const INTERVAL_ENV: Record<BillingInterval, string> = { month: "MONTHLY", year: "ANNUAL" };

export type CheckoutMode = "self_serve" | "sales" | "none";

type Env = Record<string, string | undefined>;

const PRICE_ID = /^price_[A-Za-z0-9]+$/;
const PLAN_ID = /^[a-z0-9_-]{1,40}$/;

export function isInterval(v: unknown): v is BillingInterval {
  return v === "month" || v === "year";
}

/** The environment variable that holds a plan's provider price id for an interval. */
export function priceEnvName(planId: string, interval: BillingInterval): string {
  return `STRIPE_PRICE_${planId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${INTERVAL_ENV[interval]}`;
}

/**
 * A plan's provider price id for an interval: the env mapping, else (monthly
 * only) the legacy `plans.stripe_price_id` column from migration 0013. A value
 * that doesn't look like a Stripe price id is ignored (and reported by the
 * configuration check), never sent.
 */
export function resolvePriceId(env: Env, planId: string, interval: BillingInterval, legacyMonthly?: string | null): string | null {
  if (!PLAN_ID.test(planId)) return null;
  const fromEnv = env[priceEnvName(planId, interval)]?.trim();
  if (fromEnv) return PRICE_ID.test(fromEnv) ? fromEnv : null;
  if (interval === "month" && legacyMonthly && PRICE_ID.test(legacyMonthly)) return legacyMonthly;
  return null;
}

export interface PriceRef {
  planId: string;
  interval: BillingInterval;
}

/** Reverse lookup for webhooks: which plan and interval a provider price id stands for. */
export function priceLookup(env: Env, plans: { id: string; stripe_price_id?: string | null }[]): Map<string, PriceRef> {
  const map = new Map<string, PriceRef>();
  for (const p of plans) {
    for (const interval of INTERVALS) {
      const id = resolvePriceId(env, p.id, interval, p.stripe_price_id);
      if (id && !map.has(id)) map.set(id, { planId: p.id, interval });
    }
  }
  return map;
}

/** Problems with STRIPE_PRICE_* variables: malformed values, unknown plans, one price used twice. Names only, never values. */
export function priceEnvProblems(env: Env, planIds: string[]): { variable: string; problem: string }[] {
  const out: { variable: string; problem: string }[] = [];
  const known = new Set(planIds.flatMap((id) => INTERVALS.map((i) => priceEnvName(id, i))));
  const seen = new Map<string, string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!/^STRIPE_PRICE_[A-Z0-9_]+_(MONTHLY|ANNUAL)$/.test(name)) continue;
    const v = raw?.trim();
    if (!v) continue;
    if (!PRICE_ID.test(v)) out.push({ variable: name, problem: "does not look like a Stripe price id (price_…)" });
    else if (seen.has(v)) out.push({ variable: name, problem: `uses the same price as ${seen.get(v)}` });
    else seen.set(v, name);
    if (planIds.length && !known.has(name)) out.push({ variable: name, problem: "names no plan" });
  }
  return out;
}

// ── Upgrade / downgrade ─────────────────────────────────────────────────────

export type PlanChange = "same" | "upgrade" | "downgrade";

/** Plans are ordered by sort_order: a higher one is an upgrade. */
export function planChange(from: { id: string; sortOrder: number }, to: { id: string; sortOrder: number }): PlanChange {
  if (from.id === to.id) return "same";
  return to.sortOrder > from.sortOrder ? "upgrade" : "downgrade";
}

export interface Limits {
  events: number | null;
  apps: number | null;
  seats: number | null;
}

export type DowngradeBlocker = { key: "apps" | "seats"; used: number; limit: number };

/**
 * What would be over the target plan's hard limits right now. A downgrade is
 * still allowed (the provider applies it); these are shown before the change
 * so nobody is surprised: existing apps and members stay, but no more can be
 * added until usage is under the new limit. Monthly events never block a
 * downgrade: the new allowance applies to the rest of the month with the
 * usual grace.
 */
export function downgradeBlockers(used: { apps: number; seats: number }, target: Limits): DowngradeBlocker[] {
  const out: DowngradeBlocker[] = [];
  if (target.apps !== null && used.apps > target.apps) out.push({ key: "apps", used: used.apps, limit: target.apps });
  if (target.seats !== null && used.seats > target.seats) out.push({ key: "seats", used: used.seats, limit: target.seats });
  return out;
}

// ── Entitlements ────────────────────────────────────────────────────────────

/**
 * A feature entitlement from plan_features (`feature.<name>`). Absent means
 * allowed: a feature is gated only once a plan explicitly sets it to false, so
 * adding the mechanism (or an unconfigured provider) never locks anyone out.
 */
export function entitled(features: Record<string, unknown> | null | undefined, feature: string): boolean {
  const v = features?.[`feature.${feature}`];
  return v === undefined || v === null ? true : v === true || v === "true";
}

// ── Usage-based billing (prepared, not charged) ─────────────────────────────

/**
 * Events above a usage-based plan's included allowance this period. This is
 * what metered billing would report to the provider; nothing is reported or
 * charged yet (docs/billing.md). Non-usage-based plans have no overage.
 */
export function overageEvents(used: number, included: number | null, usageBased: boolean): number {
  if (!usageBased || included === null) return 0;
  return Math.max(0, used - included);
}
