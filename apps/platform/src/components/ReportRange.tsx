import type { ReactNode } from "react";
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
export async function ReportRangeFields({ range, interval, label, compare = true }: { range: RangeInfo; interval?: Interval; label?: string; compare?: boolean }) {
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
      {compare && <CompareFields range={range} />}
    </>
  );
}

/** The comparison select and its custom dates (inside ReportRangeFields unless `compare={false}`, e.g. to sit in MoreFilters). */
export async function CompareFields({ range }: { range: RangeInfo }) {
  const t = await getT();
  return (
    <>
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

/**
 * Secondary report filters (comparison, audience, property filters). In the
 * toolbar on wide screens; on phones folded under "More filters", open when
 * one of them is in use (globals.css .filters-more).
 */
export async function MoreFilters({ open, children }: { open: boolean; children: ReactNode }) {
  const t = await getT();
  return (
    <details className="filters-more" open={open}>
      <summary>{t("More filters")}</summary>
      <div className="filters-more-body">{children}</div>
    </details>
  );
}

const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`;
const abs = (text: string) => text.replace(/^[+−]/, "");
/** Changes smaller than this (2% of the value, or 1 point of a rate) read as neutral, not good or bad. */
const SMALL_CHANGE = 0.02;
const SMALL_POINTS = 1;

/** The badge: an arrow and the size of the change; screen readers get the signed number. */
function Badge({ tone, text, title }: { tone: "up" | "down" | "flat"; text: string; title: string }) {
  const arrow = text.startsWith("+") ? "▲" : text.startsWith("−") ? "▼" : "";
  return (
    <span className={`delta delta-${tone}`} title={title}>
      <span aria-hidden>{arrow ? `${arrow} ` : ""}{abs(text)}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * The change against the comparison period as a small badge ("▲ 12%"); the
 * period and its value are in the tooltip, since the page says once what it is
 * compared with. Nothing when there is no comparison.
 */
export async function Delta({ value, previous, range, format = (n) => n.toLocaleString("en-US") }: { value: number; previous: number | null | undefined; range: RangeInfo; format?: (n: number) => string }) {
  if (previous === null || previous === undefined || !range.previous) return null;
  const t = await getT();
  const period = await previousLabel(range);
  const title = t("{value} in {period}", { value: format(previous), period });
  if (previous === 0) return <Badge tone="flat" text={t("was {value}", { value: format(previous) })} title={title} />;
  const rel = (value - previous) / previous;
  return <Badge tone={Math.abs(rel) < SMALL_CHANGE ? "flat" : rel > 0 ? "up" : "down"} text={pct(rel)} title={title} />;
}

/** Points of change between two rates (retention, conversion): "▲ 3.2 pts". */
export async function RateDelta({ value, previous, range }: { value: number | null; previous: number | null | undefined; range: RangeInfo }) {
  if (value === null || previous === null || previous === undefined || !range.previous) return null;
  const t = await getT();
  const period = await previousLabel(range);
  const pts = (value - previous) * 100;
  const sign = Math.abs(pts) < 0.05 ? "" : pts > 0 ? "+" : "−";
  return (
    <Badge tone={Math.abs(pts) < SMALL_POINTS ? "flat" : pts > 0 ? "up" : "down"}
      text={`${sign}${t("{change} pts", { change: Math.abs(pts).toFixed(1) })}`}
      title={t("{value} in {period}", { value: `${(previous * 100).toFixed(1)}%`, period })} />
  );
}
