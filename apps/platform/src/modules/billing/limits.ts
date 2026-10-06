/**
 * Plan-limit arithmetic. Pure: no database, no clock beyond the `now` passed in.
 *
 * Monthly events: a soft limit. Between 100% and 110% of the allowance
 * ingestion keeps accepting (the grace); from 110% it refuses requests with
 * `plan_limit_exceeded` until the next calendar month (UTC) or an upgrade.
 * Apps and seats are hard limits checked when one is added.
 */

/** Share of the monthly event allowance accepted past 100% before ingestion refuses. */
export const EVENT_GRACE = 0.1;

/** Thresholds (percent of the limit) at which owners are told, once per period. */
export const NOTICE_THRESHOLDS = [80, 100, 110] as const;
export type NoticeThreshold = (typeof NOTICE_THRESHOLDS)[number];

export type LimitState = "ok" | "warning" | "over" | "blocked";

/** Limit features in plan_features and what they cap. A null or absent value is unlimited. */
export const LIMIT_FEATURES = {
  events: "limit.events_per_month",
  apps: "limit.apps",
  seats: "limit.seats",
} as const;
export type LimitKey = keyof typeof LIMIT_FEATURES;

/** A plan_features value as a limit: a non-negative number, or null for unlimited. */
export function asLimit(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** The event count from which ingestion refuses: the limit plus the grace, rounded down. */
export function eventHardCap(limit: number): number {
  return Math.floor(limit * (1 + EVENT_GRACE));
}

/**
 * State of a metered limit (events): `warning` from 80%, `over` from 100%,
 * `blocked` once the grace is used up. A request is refused only when usage
 * *before* it is at or past the hard cap, so the last accepted request may
 * overshoot by at most its own size.
 */
export function eventState(used: number, limit: number | null): LimitState {
  if (limit === null) return "ok";
  if (used >= eventHardCap(limit)) return "blocked";
  if (used >= limit) return "over";
  if (used >= limit * 0.8) return "warning";
  return "ok";
}

/** State of a counted limit (apps, seats): adding one is refused at `over` (used >= limit). */
export function countState(used: number, limit: number | null): LimitState {
  if (limit === null) return "ok";
  if (used >= limit) return "over";
  if (used >= limit * 0.8) return "warning";
  return "ok";
}

/** True when one more can be added under a counted limit. */
export function canAdd(used: number, limit: number | null): boolean {
  return limit === null || used < limit;
}

/** The notice thresholds usage has reached, lowest first. */
export function thresholdsReached(used: number, limit: number | null): NoticeThreshold[] {
  if (limit === null) return [];
  return NOTICE_THRESHOLDS.filter((t) => (t === 110 ? used >= eventHardCap(limit) : used >= (limit * t) / 100));
}

/** Calendar month (UTC) that metering and limits use. */
export function usagePeriod(now: Date): { start: Date; end: Date; key: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 10) };
}

/** Seconds a refused client should wait: until the period resets, capped so an upgrade takes effect soon. */
export function retryAfterSeconds(now: Date, cap = 3600): number {
  const until = Math.ceil((usagePeriod(now).end.getTime() - now.getTime()) / 1000);
  return Math.max(60, Math.min(cap, until));
}
