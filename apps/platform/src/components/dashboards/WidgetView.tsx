import { CountUp } from "@/components/CountUp";
import { Delta } from "@/components/ReportRange";
import { TrendChart } from "@/components/TrendChart";
import { getT } from "@/i18n/server";
import { msg, type Lang, type T } from "@/i18n/translate";
import { rangeLabel } from "@/modules/analytics/range";
import { localize } from "@/modules/dashboards/localize";
import { DASHBOARD_MESSAGES, type WidgetData, type WidgetResult } from "@/modules/dashboards/service";

const INTERVALS: Record<string, string> = { day: msg("day"), week: msg("week"), month: msg("month") };
const num = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export const GROWTH_LABELS: Record<string, string> = {
  people: msg("People"),
  activated: msg("Activated people"),
  activation_rate: msg("Activation rate"),
  core_people: msg("People doing the core action"),
  paying: msg("Paying people"),
  d1: msg("D1 retention"),
  d7: msg("D7 retention"),
  d30: msg("D30 retention"),
};
const KPI_LABELS: Record<string, string> = { events: msg("Events"), people: msg("People"), active_people: msg("Active people"), all_events: msg("All events"), new_people: msg("New people") };

/** A widget's default title, from what it shows. */
export function widgetTitle(d: WidgetData, t: T, lang: Lang): string {
  const range = (r: Parameters<typeof rangeLabel>[0]) => rangeLabel(r, t, lang);
  switch (d.type) {
    case "trend": return `${d.trend.event} · ${range(d.trend.range)}`;
    case "funnel": return `${d.funnel.steps.map((s) => s.name).join(" → ")} · ${range(d.funnel.range)}`;
    case "retention": return t("Retention · {range}", { range: range(d.retention.range) });
    case "revenue": return t("Revenue · {range}", { range: range(d.revenue.range) });
    case "kpi": return `${t(KPI_LABELS[d.kpi.metric])}${d.kpi.event ? ` · ${d.kpi.event}` : ""} · ${range(d.kpi.range)}`;
    case "growth": return t(GROWTH_LABELS[d.metric] ?? "Activation");
    case "audience_size": return t("People in {audience}", { audience: d.name });
  }
}

/** The body of one dashboard widget: its chart or number, or why it can't be shown. */
export async function WidgetView({ result }: { result: WidgetResult }) {
  const t = await getT();
  if (!result.ok) return <p className="text-sm text-warn">{localize(result.error, t, DASHBOARD_MESSAGES)}</p>;
  const d = result.data;
  switch (d.type) {
    case "trend":
      return (
        <div className="space-y-2">
          <p className="text-2xl font-bold tabular-nums"><CountUp value={num(d.trend.total.count)} /> <span className="text-sm font-normal text-ink-3">{t("events · {people} people", { people: num(d.trend.total.people) })}</span></p>
          <Delta value={d.trend.total.count} previous={d.trend.previous?.count} range={d.trend.range} />
          <TrendChart days={d.trend.days} series={d.trend.series} label={t("{event} per {interval}", { event: d.trend.event, interval: t(INTERVALS[d.trend.interval] ?? d.trend.interval) })} />
        </div>
      );
    case "kpi":
      return (
        <div>
          <p className="text-3xl font-bold tabular-nums"><CountUp value={num(d.kpi.value)} /></p>
          <Delta value={d.kpi.value} previous={d.kpi.previous} range={d.kpi.range} />
        </div>
      );
    case "funnel": {
      const first = d.funnel.steps[0]?.people ?? 0;
      return (
        <ol className="space-y-1.5">
          {d.funnel.steps.map((s, i) => (
            <li key={i} className="text-sm">
              <div className="flex justify-between gap-2"><span className="truncate">{i + 1}. {s.name}</span><span className="tabular-nums">{num(s.people)} · {pct(s.fromStart)}</span></div>
              <div className="h-2 rounded bg-paper-2" data-tip={`${num(s.people)} · ${pct(s.fromStart)}`}><div className="h-2 rounded bg-accent" style={{ width: `${first ? (s.people / first) * 100 : 0}%` }} /></div>
            </li>
          ))}
        </ol>
      );
    }
    case "retention":
      return (
        <div className="space-y-1">
          <div className="grid grid-cols-5 gap-2 text-center">
            {[1, 3, 7, 14, 30].map((day, i) => (
              <div key={day}><p className="text-xs text-ink-3">D{day}</p><p className="font-semibold tabular-nums"><CountUp value={pct(d.retention.overall[i])} /></p></div>
            ))}
          </div>
          <p className="text-xs text-ink-3">{t("{n} people started", { n: num(d.retention.people) })}</p>
        </div>
      );
    case "revenue":
      return d.revenue.currencies.length === 0 ? <p className="text-sm text-ink-3">{t("No revenue in this range.")}</p> : (
        <ul className="space-y-1">
          {d.revenue.currencies.map((c) => (
            <li key={c.currency} className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums"><CountUp value={money(c.net)} /> <span className="text-sm font-normal">{c.currency}</span></span>
              <span className="text-xs text-ink-3">{t("{n} paying · ARPU {arpu}", { n: num(c.payingUsers), arpu: money(c.arpu) })}</span>
            </li>
          ))}
        </ul>
      );
    case "growth":
      if (!d.enabled) return <p className="text-sm text-ink-3">{t("Activation isn't turned on for this project.")}</p>;
      return <p className="text-3xl font-bold tabular-nums"><CountUp value={d.value === null ? "–" : d.rate ? pct(d.value) : num(d.value)} /></p>;
    case "audience_size":
      return <p className="text-3xl font-bold tabular-nums"><CountUp value={num(d.size)} /> <span className="text-sm font-normal text-ink-3">{t("people now")}</span></p>;
  }
}
