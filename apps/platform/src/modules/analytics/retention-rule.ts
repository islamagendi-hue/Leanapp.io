/**
 * The one retention rule, used by the Retention report and by Activation
 * (growth state and its D1 / D7 / D30). Pure.
 *
 * Day 0 is the calendar day a person started (their first start event in the
 * report, or their first counted event for Activation), in the app's
 * timezone. A person is retained on day N when they did the return event on
 * the calendar day N days later, not merely on or after it. Day N can only be
 * measured once it is over, so a start day counts toward day N only when
 * start day + N is before today.
 */

/** Day number of `ts` counted from the day of `start` (both timestamptz SQL expressions); `tz` is a placeholder. */
export function dayNumberSql(ts: string, start: string, tz: string): string {
  return `((${ts} at time zone ${tz})::date - (${start} at time zone ${tz})::date)`;
}

/** Whether day `n` after the day of `start` is over, so retention on it can be measured. */
export function measurableSql(start: string, n: number, tz: string): string {
  return `((${start} at time zone ${tz})::date + ${n} < (now() at time zone ${tz})::date)`;
}

/** The same check for a start day (YYYY-MM-DD) against today (YYYY-MM-DD). */
export function measurable(startDay: string, n: number, today: string): boolean {
  return Math.round((Date.parse(today) - Date.parse(startDay)) / 86_400_000) > n;
}
