/**
 * Time-zone arithmetic for quiet hours and schedules, using Intl only (no
 * date library). Pure and unit tested.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(at: Date, tz: string): LocalParts & { second: number } {
  const parts = Object.fromEntries(fmt(tz).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

/** Offset of `tz` from UTC at instant `at`, in ms (local = utc + offset). */
function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows the given local time (DST gaps resolve forward). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * If `at` falls inside quiet hours [start, end) in `tz` (the window may cross
 * midnight), returns the instant quiet hours end; otherwise null.
 */
export function quietHoursEnd(at: Date, tz: string, quiet: { start: string; end: string }): Date | null {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return null;
  const p = localParts(at, tz);
  const now = p.hour * 60 + p.minute;
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  // End is today if it's still ahead on today's clock, else tomorrow.
  const addDay = !(now < end);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + (addDay ? 1 : 0)));
  return zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), Math.floor(end / 60), end % 60, tz);
}

export interface Schedule {
  every: "day" | "week";
  at: string; // HH:MM local
  weekday?: number; // 0-6 for weekly
}

/** The first scheduled instant strictly after `after`, in `tz`. */
export function nextScheduled(after: Date, tz: string, s: Schedule): Date {
  const p = localParts(after, tz);
  const mins = minutesOf(s.at);
  for (let i = 0; i <= 8; i++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    if (s.every === "week" && d.getUTCDay() !== (s.weekday ?? 0)) continue;
    const t = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(mins / 60), mins % 60, tz);
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error("no schedule time found");
}
