import { RANGE_LABELS } from "@/components/AnalyticsHeader";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { COMPARE_LABELS, INTERVALS, RANGES, spanLabel, type Interval } from "@/modules/analytics/range";
import type { RangeInfo } from "@/modules/analytics/service";

const INTERVAL_LABELS: Record<Interval, string> = { day: msg("Day"), week: msg("Week"), month: msg("Month") };

/** The comparison period's days, in the reader's language. */
const previousLabel = async (range: RangeInfo) => spanLabel(range.previous!.from, range.previous!.to, await getLang());

/**
 * Range, custom dates, comparison and (for charts) interval inputs for a
 * report's GET form. Each pair of dates applies (and, with AutoApply, shows)
 * only when its select is on "Custom dates".
 */
export async function ReportRangeFields({ range, interval, label }: { range: RangeInfo; interval?: Interval; label?: string }) {
  const t = await getT();
  return (
    <>
      <label><span className="label">{label ?? t("Range")}</span>
        <select name="days" className="input" defaultValue={range.preset ? String(range.preset) : "custom"}>
          {RANGES.map((r) => <option key={r} value={r}>{t(RANGE_LABELS[r])}</option>)}
          <option value="custom">{t("Custom dates")}</option>
        </select>
      </label>
      <label className="custom-date"><span className="label">{t("From")}</span><input type="date" name="from" className="input" defaultValue={range.from} /></label>
      <label className="custom-date"><span className="label">{t("To")}</span><input type="date" name="to" className="input" defaultValue={range.to} /></label>
      {interval && (
        <label><span className="label">{t("By")}</span>
          <select name="interval" className="input" defaultValue={interval}>{INTERVALS.map((i) => <option key={i} value={i}>{t(INTERVAL_LABELS[i])}</option>)}</select>
        </label>
      )}
      <label><span className="label">{t("Compare with")}</span>
        <select name="compare" className="input" defaultValue={range.previous?.kind ?? ""}>
          <option value="">{t("No comparison")}</option>
          {(Object.keys(COMPARE_LABELS) as (keyof typeof COMPARE_LABELS)[]).map((k) => <option key={k} value={k}>{t(COMPARE_LABELS[k])}</option>)}
        </select>
      </label>
      <label className="compare-date"><span className="label">{t("Compare from")}</span><input type="date" name="cfrom" className="input" defaultValue={range.previous?.kind === "custom" ? range.previous.from : undefined} /></label>
      <label className="compare-date"><span className="label">{t("Compare until")}</span><input type="date" name="cto" className="input" defaultValue={range.previous?.kind === "custom" ? range.previous.to : undefined} /></label>
    </>
  );
}

const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`;

/** "+12% vs 1 Sep – 30 Sep" for a value and its comparison-period value; nothing when there is no comparison. */
export async function Delta({ value, previous, range, format = (n) => n.toLocaleString("en-US") }: { value: number; previous: number | null | undefined; range: RangeInfo; format?: (n: number) => string }) {
  if (previous === null || previous === undefined || !range.previous) return null;
  const t = await getT();
  const period = await previousLabel(range);
  const rel = previous === 0 ? null : (value - previous) / previous;
  const tone = rel === null || rel === 0 ? "text-ink-3" : rel > 0 ? "text-accent-ink" : "text-alert";
  return (
    <span className={`text-xs ${tone}`} title={t("{value} in {period}", { value: format(previous), period })}>
      {rel === null ? t("from {value} vs {period}", { value: format(previous), period }) : t("{change} vs {period}", { change: pct(rel), period })}
    </span>
  );
}

/** Points of change between two rates (retention, conversion): "+3.2 pts vs …". */
export async function RateDelta({ value, previous, range }: { value: number | null; previous: number | null | undefined; range: RangeInfo }) {
  if (value === null || previous === null || previous === undefined || !range.previous) return null;
  const t = await getT();
  const period = await previousLabel(range);
  const pts = (value - previous) * 100;
  const tone = Math.abs(pts) < 0.05 ? "text-ink-3" : pts > 0 ? "text-accent-ink" : "text-alert";
  return (
    <span className={`text-xs ${tone}`} title={t("{value} in {period}", { value: `${(previous * 100).toFixed(1)}%`, period })}>
      {t("{change} pts", { change: `${pts >= 0 ? "+" : "−"}${Math.abs(pts).toFixed(1)}` })}
    </span>
  );
}
