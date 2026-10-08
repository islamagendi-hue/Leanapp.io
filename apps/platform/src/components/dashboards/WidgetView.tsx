import { Delta } from "@/components/ReportRange";
import { TrendChart } from "@/components/TrendChart";
import type { WidgetData, WidgetResult } from "@/modules/dashboards/service";

const num = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export const GROWTH_LABELS: Record<string, string> = {
  people: "People",
  activated: "Activated people",
  activation_rate: "Activation rate",
  core_people: "People doing the core action",
  paying: "Paying people",
  d1: "D1 retention",
  d7: "D7 retention",
  d30: "D30 retention",
};
const KPI_LABELS: Record<string, string> = { events: "Events", people: "People", active_people: "Active people", all_events: "All events", new_people: "New people" };

/** A widget's default title, from what it shows. */
export function widgetTitle(d: WidgetData): string {
  switch (d.type) {
    case "trend": return `${d.trend.event} · ${d.trend.range.label}`;
    case "funnel": return `${d.funnel.steps.map((s) => s.name).join(" → ")} · ${d.funnel.range.label}`;
    case "retention": return `Retention · ${d.retention.range.label}`;
    case "revenue": return `Revenue · ${d.revenue.range.label}`;
    case "kpi": return `${KPI_LABELS[d.kpi.metric]}${d.kpi.event ? ` · ${d.kpi.event}` : ""} · ${d.kpi.range.label}`;
    case "growth": return GROWTH_LABELS[d.metric] ?? "Activation";
    case "audience_size": return `People in ${d.name}`;
  }
}

/** The body of one dashboard widget: its chart or number, or why it can't be shown. */
export function WidgetView({ result }: { result: WidgetResult }) {
  if (!result.ok) return <p className="text-sm text-warn">{result.error}</p>;
  const d = result.data;
  switch (d.type) {
    case "trend":
      return (
        <div className="space-y-2">
          <p className="text-2xl font-bold tabular-nums">{num(d.trend.total.count)} <span className="text-sm font-normal text-ink-3">events · {num(d.trend.total.people)} people</span></p>
          <Delta value={d.trend.total.count} previous={d.trend.previous?.count} range={d.trend.range} />
          <TrendChart days={d.trend.days} series={d.trend.series} label={`${d.trend.event} per ${d.trend.interval}`} />
        </div>
      );
    case "kpi":
      return (
        <div>
          <p className="text-3xl font-bold tabular-nums">{num(d.kpi.value)}</p>
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
              <div className="h-2 rounded bg-paper-2"><div className="h-2 rounded bg-accent" style={{ width: `${first ? (s.people / first) * 100 : 0}%` }} /></div>
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
              <div key={day}><p className="text-xs text-ink-3">D{day}</p><p className="font-semibold tabular-nums">{pct(d.retention.overall[i])}</p></div>
            ))}
          </div>
          <p className="text-xs text-ink-3">{num(d.retention.people)} people started</p>
        </div>
      );
    case "revenue":
      return d.revenue.currencies.length === 0 ? <p className="text-sm text-ink-3">No revenue in this range.</p> : (
        <ul className="space-y-1">
          {d.revenue.currencies.map((c) => (
            <li key={c.currency} className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums">{money(c.net)} <span className="text-sm font-normal">{c.currency}</span></span>
              <span className="text-xs text-ink-3">{num(c.payingUsers)} paying · ARPU {money(c.arpu)}</span>
            </li>
          ))}
        </ul>
      );
    case "growth":
      if (!d.enabled) return <p className="text-sm text-ink-3">Activation isn&apos;t turned on for this project.</p>;
      return <p className="text-3xl font-bold tabular-nums">{d.value === null ? "–" : d.rate ? pct(d.value) : num(d.value)}</p>;
    case "audience_size":
      return <p className="text-3xl font-bold tabular-nums">{num(d.size)} <span className="text-sm font-normal text-ink-3">people now</span></p>;
  }
}
