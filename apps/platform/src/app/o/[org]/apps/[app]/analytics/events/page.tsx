import Link from "next/link";
import { AnalyticsHeader, param, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { TrendChart } from "@/components/TrendChart";
import { BREAKDOWNS, eventTrend, RANGES, topEvents } from "@/modules/analytics/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Events" };

const BREAKDOWN_LABELS: Record<string, string> = { platform: "Platform", app_version: "App version", country: "Country" };
const num = (n: number) => n.toLocaleString("en-US");

export default async function EventsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/events">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = pickEnvironment(environments, sp.env ?? "production");
  const days = Number(param(sp.days)) || 30;
  const events = await topEvents(ctx, { environmentId: env.id, days });
  const selected = param(sp.event) ?? events[0]?.name;
  const property = param(sp.property)?.trim();
  const by = param(sp.by);
  const breakdown = by === "property" && property ? `property:${property}` : by;
  const trend = selected ? await eventTrend(ctx, { environmentId: env.id, timezone: a.timezone }, { event: selected, days, breakdown }) : null;
  const path = `/o/${org}/apps/${app}/analytics/events`;
  const link = (name: string) => `${path}?${new URLSearchParams({ env: env.type, days: String(days), event: name })}`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Events" description="How often each event happens and how many people do it, per day in the app's timezone." path={path} env={env.type} query={sp} />

      {events.length === 0 ? (
        <div className="card">
          <p>No events in this environment in the {RANGE_LABELS[days]?.toLowerCase() ?? "selected range"}.</p>
          <p className="mt-1 text-sm text-ink-3">Events appear here as soon as your app sends them. Check the <Link className="underline" href={`/o/${org}/apps/${app}/developers/debugger?env=${env.type}`}>event debugger</Link>.</p>
        </div>
      ) : (
        <>
          <form method="get" className="card flex flex-wrap items-end gap-3">
            <input type="hidden" name="env" value={env.type} />
            <label className="min-w-48 flex-1"><span className="label">Event</span>
              <select name="event" className="input" defaultValue={selected}>{events.map((e) => <option key={e.name}>{e.name}</option>)}</select>
            </label>
            <label><span className="label">Range</span>
              <select name="days" className="input" defaultValue={String(days)}>{RANGES.map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}</select>
            </label>
            <label><span className="label">Split by</span>
              <select name="by" className="input" defaultValue={by ?? ""}>
                <option value="">Nothing</option>
                {BREAKDOWNS.map((b) => <option key={b} value={b}>{BREAKDOWN_LABELS[b]}</option>)}
                <option value="property">Event property…</option>
              </select>
            </label>
            <label><span className="label">Property</span><input name="property" className="input w-40" defaultValue={property ?? ""} placeholder="e.g. plan" maxLength={64} /></label>
            <button className="btn" type="submit">Show</button>
          </form>

          {trend && (
            <section className="card space-y-4">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <h2 className="h2 font-mono">{trend.event}</h2>
                <span className="text-sm text-ink-2"><strong>{num(trend.total.count)}</strong> events</span>
                <span className="text-sm text-ink-2"><strong>{num(trend.total.people)}</strong> people</span>
              </div>
              <TrendChart days={trend.days} series={trend.series} label={`${trend.event} per day`} />
              {trend.series.some((s) => s.key === "Other") && <p className="text-xs text-ink-3">The 5 most frequent values are shown; the rest are grouped as Other.</p>}
            </section>
          )}

          <section className="card overflow-x-auto p-0">
            <table className="table">
              <thead><tr><th>Event</th><th className="text-right">Events</th><th className="text-right">People</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.name}>
                    <td className="font-mono text-sm"><Link className={e.name === selected ? "font-bold" : "underline"} href={link(e.name)}>{e.name}</Link></td>
                    <td className="text-right tabular-nums">{num(e.count)}</td>
                    <td className="text-right tabular-nums">{num(e.people)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-ink-3">Mapped events count under their canonical name. Anonymous activity counts toward the user once the install is linked to exactly one user.</p>
        </>
      )}
    </div>
  );
}
