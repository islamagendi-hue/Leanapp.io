/**
 * Capability status, freshness and sync scheduling. Pure (unit-tested in
 * status.test.ts); the service stores the result on integration_capabilities
 * and the Integrations Center shows it per capability.
 *
 *   not_configured       nothing set up for this capability (or it is turned off)
 *   credentials_missing  set up, but a required credential or setting is missing
 *   unverified           credentials stored, no successful call to the live provider yet
 *   verified             the last call to the provider succeeded
 *   error                the last call failed (see last_error)
 */
export const CAPABILITY_STATUSES = ["not_configured", "credentials_missing", "unverified", "verified", "error"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface StatusInput {
  enabled: boolean;
  /** Required credentials and settings are all present. */
  complete: boolean;
  verifiedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
}

export function deriveStatus(s: StatusInput): CapabilityStatus {
  if (!s.enabled) return "not_configured";
  if (!s.complete) return "credentials_missing";
  const ok = Math.max(s.verifiedAt?.getTime() ?? 0, s.lastSuccessAt?.getTime() ?? 0);
  const bad = s.lastErrorAt?.getTime() ?? 0;
  if (bad && bad >= ok) return "error";
  if (ok) return "verified";
  return "unverified";
}

export type Freshness = "fresh" | "stale" | "none";

/**
 * How current imported data is: `fresh` when the last fully imported day is
 * at most `maxLagDays` before today (ad networks restate the last days, so a
 * one-day lag is normal), `stale` when older, `none` when nothing was imported.
 */
export function freshness(freshThrough: string | null, today: string, maxLagDays = 2): { state: Freshness; lagDays: number | null } {
  if (!freshThrough) return { state: "none", lagDays: null };
  const lag = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${freshThrough}T00:00:00Z`)) / 86_400_000);
  return { state: lag <= maxLagDays ? "fresh" : "stale", lagDays: Math.max(lag, 0) };
}

export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Days networks may still restate: each incremental run re-imports them. */
export const RESTATEMENT_DAYS = 3;
/** First import without a backfill request covers this many days. */
export const INITIAL_DAYS = 30;
/** One sync run requests at most this many days (networks cap daily ranges). */
export const CHUNK_DAYS = 30;
/** Backfill reaches back at most this far. */
export const MAX_BACKFILL_DAYS = 395;

export interface SyncPlanInput {
  today: string;
  freshThrough: string | null;
  backfillFrom: string | null;
  backfillCursor: string | null;
}

/**
 * The day range the next run imports. Backfill first (oldest chunk below the
 * cursor, walking back to `backfillFrom`), else incremental: from a few days
 * before the last imported day (restatements) to today.
 */
export function planSync(s: SyncPlanInput): { kind: "incremental" | "backfill"; from: string; to: string } {
  if (s.backfillFrom) {
    // Below the first window the incremental import covers (re-importing an overlap is harmless: rows are replaced).
    const upper = s.backfillCursor ? addDays(s.backfillCursor, -1) : addDays(s.today, -INITIAL_DAYS);
    if (upper >= s.backfillFrom) {
      const from = addDays(upper, -(CHUNK_DAYS - 1)) < s.backfillFrom ? s.backfillFrom : addDays(upper, -(CHUNK_DAYS - 1));
      return { kind: "backfill", from, to: upper };
    }
  }
  // After a long pause, catch up chunk by chunk (oldest first) instead of leaving a gap.
  const start = s.freshThrough ? addDays(s.freshThrough, -RESTATEMENT_DAYS) : addDays(s.today, -(INITIAL_DAYS - 1));
  const end = addDays(start, CHUNK_DAYS - 1);
  return { kind: "incremental", from: start, to: end < s.today ? end : s.today };
}

/** Wait before retrying after `failures` consecutive failed runs (minutes). Auth errors wait for new credentials instead. */
export function retryDelayMinutes(failures: number): number {
  const steps = [15, 60, 360, 1440];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1];
}

/** Hours between successful incremental runs. */
export const SYNC_INTERVAL_HOURS = 6;
