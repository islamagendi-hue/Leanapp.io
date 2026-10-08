/**
 * Report date ranges, intervals and comparison periods, shared by every
 * report. Pure (no database access).
 *
 * A range is either a preset (the last 7, 30 or 90 days, ending now) or a
 * custom span of calendar days in the app's timezone (`from` to `to`,
 * inclusive; a span that reaches today ends now). The comparison period is the
 * span of the same length that ends where the range starts.
 */
import { z } from "zod";

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
export const INTERVALS = ["day", "week", "month"] as const;
export type Interval = (typeof INTERVALS)[number];
export const MAX_CUSTOM_DAYS = 366;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)));

export function rangeDays(v: unknown): RangeDays {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as RangeDays) : 30;
}

/**
 * Range fields every report schema accepts. Configs saved before custom
 * ranges existed only have `days` and keep meaning exactly what they did.
 */
export const rangeFields = {
  days: z.unknown().optional().transform(rangeDays),
  from: isoDate.optional().catch(undefined),
  to: isoDate.optional().catch(undefined),
  compare: z.unknown().optional().transform((v) => (v === true || v === "1" || v === "true" || v === "on" ? true : undefined)),
};

export const intervalField = z.enum(INTERVALS).optional().catch(undefined);

export interface ReportRange {
  /** The preset, or null for a custom range. */
  preset: RangeDays | null;
  /** First and last calendar day (YYYY-MM-DD, app timezone), inclusive. */
  from: string;
  to: string;
  /** Instant bounds: start inclusive, end exclusive. */
  start: Date;
  end: Date;
  label: string;
}

const DAY = 86_400_000;

/** Calendar date (YYYY-MM-DD) of an instant in `timezone`. */
export function localDate(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Offset of `timezone` from UTC at an instant, in ms (positive east of UTC). */
function offsetMs(timezone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a calendar day starts in `timezone`. */
export function startOfDay(date: string, timezone: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - offsetMs(timezone, new Date(guess));
  const second = guess - offsetMs(timezone, new Date(first));
  return new Date(second);
}

/** `date` plus `n` calendar days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The range a report covers. A custom range wins when both its days are valid. */
export function resolveRange(input: { days?: unknown; from?: string; to?: string }, timezone: string, now = new Date()): ReportRange {
  const today = localDate(now, timezone);
  const parsedFrom = isoDate.safeParse(input.from);
  const parsedTo = isoDate.safeParse(input.to);
  if (parsedFrom.success && parsedTo.success) {
    let from = parsedFrom.data <= parsedTo.data ? parsedFrom.data : parsedTo.data;
    let to = parsedFrom.data <= parsedTo.data ? parsedTo.data : parsedFrom.data;
    if (to > today) to = today;
    if (from > to) from = to;
    if (datesBetween(from, to).length > MAX_CUSTOM_DAYS) from = addDays(to, -(MAX_CUSTOM_DAYS - 1));
    const start = startOfDay(from, timezone);
    const dayAfter = startOfDay(addDays(to, 1), timezone);
    const end = dayAfter > now ? now : dayAfter;
    return { preset: null, from, to, start, end, label: from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}` };
  }
  const days = rangeDays(input.days);
  const start = new Date(now.getTime() - days * DAY);
  return { preset: days, from: localDate(start, timezone), to: today, start, end: now, label: `Last ${days} days` };
}

/** The period of the same length that ends where `range` starts. */
export function previousRange(range: ReportRange, timezone: string): ReportRange {
  const length = range.end.getTime() - range.start.getTime();
  const start = new Date(range.start.getTime() - length);
  const end = range.start;
  const from = localDate(start, timezone);
  const to = localDate(new Date(end.getTime() - 1), timezone);
  return { preset: range.preset, from, to, start, end, label: from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}` };
}

/** Monday of the ISO week containing `date`. */
function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Bucket keys for a range: each calendar day, the Monday of each week, or the
 * first of each month (the first bucket can start before the range does).
 */
export function bucketKeys(range: Pick<ReportRange, "from" | "to">, interval: Interval): string[] {
  const days = datesBetween(range.from, range.to);
  if (interval === "day") return days;
  const key = interval === "week" ? weekStart : (d: string) => `${d.slice(0, 7)}-01`;
  return [...new Set(days.map(key))];
}

/** SQL bucket (a date) for a timestamp expression; `tz` is the timezone placeholder. Matches bucketKeys. */
export function bucketSql(ts: string, tz: string, interval: Interval): string {
  if (interval === "day") return `(${ts} at time zone ${tz})::date`;
  return `date_trunc('${interval}', ${ts} at time zone ${tz})::date`;
}

/** The interval a report uses: the requested one, else days (weeks for ranges longer than 90 days). */
export function defaultInterval(range: Pick<ReportRange, "from" | "to">, requested?: Interval): Interval {
  if (requested) return requested;
  return datesBetween(range.from, range.to).length > 92 ? "week" : "day";
}

/** Relative change from `previous` to `current`, or null when there is nothing to compare with. */
export function change(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / previous;
}
