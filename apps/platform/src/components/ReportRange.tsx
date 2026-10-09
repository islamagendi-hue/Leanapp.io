import { RANGE_LABELS } from "@/components/AnalyticsHeader";
import { INTERVALS, RANGES, type Interval } from "@/modules/analytics/range";
import type { RangeInfo } from "@/modules/analytics/service";

const INTERVAL_LABELS: Record<Interval, string> = { day: "Day", week: "Week", month: "Month" };

/**
 * Range, custom dates, comparison and (for charts) interval inputs for a
 * report's GET form. The dates apply (and, with AutoApply, show) when the range is "Custom dates".
 */
export function ReportRangeFields({ range, interval, label = "Range" }: { range: RangeInfo; interval?: Interval; label?: string }) {
  return (
    <>
      <label><span className="label">{label}</span>
        <select name="days" className="input" defaultValue={range.preset ? String(range.preset) : "custom"}>
          {RANGES.map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
          <option value="custom">Custom dates</option>
        </select>
      </label>
      <label className="custom-date"><span className="label">From</span><input type="date" name="from" className="input" defaultValue={range.from} /></label>
      <label className="custom-date"><span className="label">To</span><input type="date" name="to" className="input" defaultValue={range.to} /></label>
      {interval && (
        <label><span className="label">By</span>
          <select name="interval" className="input" defaultValue={interval}>{INTERVALS.map((i) => <option key={i} value={i}>{INTERVAL_LABELS[i]}</option>)}</select>
        </label>
      )}
      <label className="flex min-h-10 items-center gap-2 text-sm">
        <input type="checkbox" name="compare" value="1" defaultChecked={!!range.previous} /> Compare to previous period
      </label>
    </>
  );
}

const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`;

/** "+12% vs 1 Sep – 30 Sep" for a value and its comparison-period value; nothing when there is no comparison. */
export function Delta({ value, previous, range, format = (n) => n.toLocaleString("en-US") }: { value: number; previous: number | null | undefined; range: RangeInfo; format?: (n: number) => string }) {
  if (previous === null || previous === undefined || !range.previous) return null;
  const rel = previous === 0 ? null : (value - previous) / previous;
  const tone = rel === null || rel === 0 ? "text-ink-3" : rel > 0 ? "text-accent-ink" : "text-alert";
  return (
    <span className={`text-xs ${tone}`} title={`${format(previous)} in ${range.previous.label}`}>
      {rel === null ? `from ${format(previous)}` : pct(rel)} vs {range.previous.label}
    </span>
  );
}

/** Points of change between two rates (retention, conversion): "+3.2 pts vs …". */
export function RateDelta({ value, previous, range }: { value: number | null; previous: number | null | undefined; range: RangeInfo }) {
  if (value === null || previous === null || previous === undefined || !range.previous) return null;
  const pts = (value - previous) * 100;
  const tone = Math.abs(pts) < 0.05 ? "text-ink-3" : pts > 0 ? "text-accent-ink" : "text-alert";
  return <span className={`text-xs ${tone}`} title={`${(previous * 100).toFixed(1)}% in ${range.previous.label}`}>{pts >= 0 ? "+" : "−"}{Math.abs(pts).toFixed(1)} pts</span>;
}
