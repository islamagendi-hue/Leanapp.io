import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { AutoApply } from "@/components/AutoApply";
import { CohortSelect } from "@/components/CohortSelect";
import { RateDelta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { eventLabels } from "@/modules/analytics/labels";
import { resolveRange } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { ANY_EVENT, RETENTION_DAYS, retention, topEvents } from "@/modules/analytics/service";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
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
  const env = await pickEnvironment(environments, sp.env);
  const range = rangeFromParams(toSearch(sp));
  const cf = await cohortFilter(ctx, env.id, sp.cohort);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const reports = reportRunner(ctx, scope, sp);
  const events = await reports.run("top_events", { ...range }, () => topEvents(ctx, { ...scope, ...range }));
  const startEvent = param(sp.start) || events.find((e) => /install|first_open|sign_?up/.test(e.name))?.name || events[0]?.name;
  // Coming back means doing anything again unless the user picks a return event:
  // a start event that happens once per person (an install) would retain no one.
  const returnEvent = param(sp.return) || events.find((e) => /app_opened|session_start/.test(e.name))?.name || ANY_EVENT;
  const retentionInput = { startEvent, returnEvent, ...range, cohortId: cf.cohortId };
  const r = startEvent && returnEvent ? await reports.run("retention", retentionInput, () => retention(ctx, scope, retentionInput)) : null;
  const names = events.map((e) => e.name);
  const label = await eventLabels(ctx, a.id);

  return (
    <div className="space-y-6">
      <AnalyticsHeader title="Retention" description="Of the people who did a start event on a given day, how many came back and did the return event N days later." env={env.type} />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/retention`} sp={sp} />

      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">That audience is archived or no longer exists in this environment, so the report shows everyone.</p>}
      {!r ? (
        <div className="card"><p>No events in this environment in {(() => { const x = resolveRange(range, a.timezone); return x.preset ? `the ${x.label.toLowerCase()}` : x.label; })()}.</p></div>
      ) : (
        <>
          <form method="get" className="card flex flex-wrap items-end gap-3">
            <input type="hidden" name="env" value={env.type} />
            <AutoApply />
            <label className="min-w-48 flex-1"><span className="label">Start event</span>
              <select name="start" className="input" defaultValue={startEvent}>{names.map((n) => <option key={n} value={n}>{label(n)}</option>)}</select>
            </label>
            <label className="min-w-48 flex-1"><span className="label">Return event</span>
              <select name="return" className="input" defaultValue={returnEvent}><option value={ANY_EVENT}>Any event</option>{names.map((n) => <option key={n} value={n}>{label(n)}</option>)}</select>
            </label>
            <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
            <ReportRangeFields label="Cohorts from" range={r.range} />
            <button className="btn" type="submit" data-apply>Show</button>
          </form>

          <section className="card overflow-x-auto p-0">
            <table className="table">
              <thead>
                <tr><th>Start day</th><th className="text-end">People</th>{RETENTION_DAYS.map((d) => <th key={d} className="text-center">Day {d}</th>)}</tr>
              </thead>
              <tbody>
                <tr className="font-medium">
                  <td>All cohorts</td>
                  <td className="text-end tabular-nums">{r.people.toLocaleString("en-US")}</td>
                  {r.overall.map((rate, i) => {
                    const c = cell(rate);
                    return (
                      <td key={i} className={`text-center tabular-nums ${c.className}`} style={c.style}>
                        {rate === null ? "–" : pct(rate)}
                        {r.previous && <span className="block rounded bg-card px-1"><RateDelta value={rate} previous={r.previous[i]} range={r.range} /></span>}
                      </td>
                    );
                  })}
                </tr>
                {r.cohorts.map((co) => (
                  <tr key={co.day}>
                    <td className="whitespace-nowrap">{co.day}</td>
                    <td className="text-end tabular-nums">{co.size.toLocaleString("en-US")}</td>
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
          <p className="text-xs text-ink-3">People are grouped by the day of their first start event in the range ({a.timezone}). Day N counts people who did the return event on that calendar day; Activation uses the same rule for its D1, D7 and D30. Empty cells are days that aren&apos;t over yet.{r.range.previous && <> Changes are against cohorts from {r.range.previous.label}.</>}{cf.cohortName && <> Only people in the audience {cf.cohortName}.</>}</p>
          {cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="retention" query={{ ...sp, start: startEvent, return: returnEvent }} />}
        </>
      )}
    </div>
  );
}
