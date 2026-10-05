import { AnalyticsHeader, param, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { RANGES, RETENTION_DAYS, retention, topEvents } from "@/modules/analytics/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Retention" };

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Green with opacity by rate, so the table reads as a heat map. */
function cell(rate: number | null) {
  if (rate === null) return { className: "text-ink-3", style: undefined };
  return { className: rate >= 0.5 ? "text-paper" : "text-ink", style: { background: `rgba(15, 107, 79, ${0.08 + rate * 0.82})` } };
}

export default async function RetentionPage(props: PageProps<"/o/[org]/apps/[app]/analytics/retention">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = pickEnvironment(environments, sp.env ?? "production");
  const days = Number(param(sp.days)) || 30;
  const events = await topEvents(ctx, { environmentId: env.id, days });
  const startEvent = param(sp.start) || events.find((e) => /install|first_open|sign_?up/.test(e.name))?.name || events[0]?.name;
  const returnEvent = param(sp.return) || events.find((e) => /app_opened|session_start/.test(e.name))?.name || startEvent;
  const r = startEvent && returnEvent
    ? await retention(ctx, { environmentId: env.id, timezone: a.timezone }, { startEvent, returnEvent, days })
    : null;
  const path = `/o/${org}/apps/${app}/analytics/retention`;
  const names = events.map((e) => e.name);

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Retention" description="Of the people who did a start event on a given day, how many came back and did the return event N days later." path={path} env={env.type} query={sp} />

      {!r ? (
        <div className="card"><p>No events in this environment in the {RANGE_LABELS[days]?.toLowerCase() ?? "selected range"}.</p></div>
      ) : (
        <>
          <form method="get" className="card flex flex-wrap items-end gap-3">
            <input type="hidden" name="env" value={env.type} />
            <label className="min-w-48 flex-1"><span className="label">Start event</span>
              <select name="start" className="input" defaultValue={startEvent}>{names.map((n) => <option key={n}>{n}</option>)}</select>
            </label>
            <label className="min-w-48 flex-1"><span className="label">Return event</span>
              <select name="return" className="input" defaultValue={returnEvent}>{names.map((n) => <option key={n}>{n}</option>)}</select>
            </label>
            <label><span className="label">Cohorts from</span>
              <select name="days" className="input" defaultValue={String(days)}>{RANGES.map((d) => <option key={d} value={d}>{RANGE_LABELS[d]}</option>)}</select>
            </label>
            <button className="btn" type="submit">Show</button>
          </form>

          <section className="card overflow-x-auto p-0">
            <table className="table">
              <thead>
                <tr><th>Start day</th><th className="text-right">People</th>{RETENTION_DAYS.map((d) => <th key={d} className="text-center">Day {d}</th>)}</tr>
              </thead>
              <tbody>
                <tr className="font-medium">
                  <td>All cohorts</td>
                  <td className="text-right tabular-nums">{r.people.toLocaleString("en-US")}</td>
                  {r.overall.map((rate, i) => {
                    const c = cell(rate);
                    return <td key={i} className={`text-center tabular-nums ${c.className}`} style={c.style}>{rate === null ? "–" : pct(rate)}</td>;
                  })}
                </tr>
                {r.cohorts.map((co) => (
                  <tr key={co.day}>
                    <td className="whitespace-nowrap">{co.day}</td>
                    <td className="text-right tabular-nums">{co.size.toLocaleString("en-US")}</td>
                    {co.returned.map((n, i) => {
                      const rate = n === null ? null : n / co.size;
                      const c = cell(rate);
                      return <td key={i} className={`text-center tabular-nums ${c.className}`} style={c.style} title={n === null ? "Not reached yet" : `${n} of ${co.size}`}>{rate === null ? "" : pct(rate)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-ink-3">People are grouped by the day of their first start event in the range ({a.timezone}). Day N counts people who did the return event on that calendar day. Empty cells are days that aren&apos;t over yet.</p>
        </>
      )}
    </div>
  );
}
