/**
 * Churn (Retention → Churn; queries in ./churn.ts). Pure, so the rules are
 * unit tested and the page, the report and the saved audiences share them.
 *
 * A person's last activity is their profile's Last seen: the time of the
 * latest event the app sent for them, of any kind (the same value audiences
 * use for "last seen"). With a churn window of N days:
 * - churned: last seen more than N days ago,
 * - at risk: last seen more than N/2 days ago, but within N days,
 * - active: last seen within the last N/2 days.
 * Everyone with any activity on record is in exactly one bucket.
 *
 * Churn rate over time, for each week or month: of the people active at its
 * start (an event in the N days before it), the share with no event in the N
 * days up to its end, so they had churned by then. Days are calendar days in
 * the app's timezone; the current period counts up to today.
 */
import { msg } from "@/i18n/translate";
import type { AudienceNode } from "@/modules/audiences/definition";
import { addDays, type Interval } from "./range";

export const CHURN_WINDOWS = [14, 30, 60, 90] as const;
export type ChurnWindow = (typeof CHURN_WINDOWS)[number];
export const DEFAULT_CHURN_WINDOW: ChurnWindow = 30;

export function churnWindow(v: unknown): ChurnWindow {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (CHURN_WINDOWS as readonly number[]).includes(n) ? (n as ChurnWindow) : DEFAULT_CHURN_WINDOW;
}

/** Days without activity after which a person is at risk: half the window (every window is even). */
export const atRiskDays = (window: ChurnWindow) => window / 2;

export const CHURN_BUCKETS = ["churned", "at_risk", "active"] as const;
export type ChurnBucket = (typeof CHURN_BUCKETS)[number];
export const BUCKET_LABELS: Record<ChurnBucket, string> = { churned: msg("Churned"), at_risk: msg("At risk"), active: msg("Active") };

const DAY = 86_400_000;

export function classify(lastSeen: Date, now: Date, window: ChurnWindow): ChurnBucket {
  const t = lastSeen.getTime();
  if (t < now.getTime() - window * DAY) return "churned";
  if (t < now.getTime() - atRiskDays(window) * DAY) return "at_risk";
  return "active";
}

/** `classify` in SQL for a timestamptz column; `window` and `half` are int placeholders. Matches the audience "last seen" rule. */
export function bucketSql(col: string, window: string, half: string): string {
  return `case when ${col} < now() - make_interval(days => ${window}::int) then 'churned'
               when ${col} < now() - make_interval(days => ${half}::int) then 'at_risk'
               else 'active' end`;
}

/**
 * The audience of a bucket, from the same "last seen" conditions the
 * audience editor offers, so it stays in step with the page as people come and go.
 */
export function churnAudience(bucket: ChurnBucket, window: ChurnWindow): AudienceNode {
  const half = atRiskDays(window);
  if (bucket === "churned") return { type: "last_seen", op: "before_days", days: window };
  if (bucket === "at_risk") {
    return { type: "and", children: [{ type: "last_seen", op: "before_days", days: half }, { type: "last_seen", op: "within_days", days: window }] };
  }
  return { type: "last_seen", op: "within_days", days: half };
}

export const CHURN_INTERVALS = ["week", "month"] as const satisfies readonly Interval[];
export type ChurnInterval = (typeof CHURN_INTERVALS)[number];
/** How many periods the chart shows. */
export const PERIODS: Record<ChurnInterval, number> = { week: 12, month: 6 };

export function churnInterval(v: unknown): ChurnInterval {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "month" ? "month" : "week";
}

export interface ChurnPeriod {
  /** First day (a Monday, or the 1st of a month). */
  start: string;
  /** The day after the last day counted: the next period's start, or tomorrow for the current one. */
  end: string;
  /** The current period, counted up to today. */
  partial: boolean;
}

/** The last `count` weeks (Monday first) or months up to and including the one containing `today`. */
export function churnPeriods(today: string, interval: ChurnInterval, count = PERIODS[interval]): ChurnPeriod[] {
  const startOf = (d: string) => (interval === "week" ? addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7)) : `${d.slice(0, 7)}-01`);
  const next = (s: string) => (interval === "week" ? addDays(s, 7) : nextMonth(s));
  const prev = (s: string) => (interval === "week" ? addDays(s, -7) : startOf(addDays(s, -1)));
  const starts = [startOf(today)];
  while (starts.length < count) starts.unshift(prev(starts[0]));
  const tomorrow = addDays(today, 1);
  return starts.map((start) => {
    const end = next(start);
    return end > tomorrow ? { start, end: tomorrow, partial: true } : { start, end, partial: false };
  });
}

function nextMonth(first: string): string {
  const [y, m] = first.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export interface ChurnPoint extends ChurnPeriod {
  /** People active at the period's start. */
  base: number;
  /** Of them, people with no activity in the window up to the period's end. */
  churned: number;
  /** churned ÷ base; null without a base. */
  rate: number | null;
}

/** The periods with their counts (periods missing from `rows` had nobody active at their start). */
export function churnSeries(periods: ChurnPeriod[], rows: { start: string; base: number; churned: number }[]): ChurnPoint[] {
  const by = new Map(rows.map((r) => [r.start, r]));
  return periods.map((p) => {
    const r = by.get(p.start);
    const base = r?.base ?? 0;
    const churned = r?.churned ?? 0;
    return { ...p, base, churned, rate: base ? churned / base : null };
  });
}

export interface ChannelChurn {
  channel: string;
  people: number;
  churned: number;
  atRisk: number;
  active: number;
  /** churned ÷ people. */
  rate: number;
}

/** Buckets per acquisition channel, the biggest channel first. */
export function churnByChannel(rows: { channel: string; bucket: ChurnBucket; people: number }[]): ChannelChurn[] {
  const by = new Map<string, ChannelChurn>();
  for (const r of rows) {
    if (!by.has(r.channel)) by.set(r.channel, { channel: r.channel, people: 0, churned: 0, atRisk: 0, active: 0, rate: 0 });
    const c = by.get(r.channel)!;
    c.people += r.people;
    if (r.bucket === "churned") c.churned += r.people;
    else if (r.bucket === "at_risk") c.atRisk += r.people;
    else c.active += r.people;
  }
  return [...by.values()]
    .map((c) => ({ ...c, rate: c.people ? c.churned / c.people : 0 }))
    .sort((a, b) => b.people - a.people || a.channel.localeCompare(b.channel));
}
