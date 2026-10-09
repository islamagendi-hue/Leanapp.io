import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { getLang, getT } from "@/i18n/server";
import { AutoApply } from "@/components/AutoApply";
import { CohortSelect } from "@/components/CohortSelect";
import { CompareFields, MoreFilters, RateDelta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { eventLabels } from "@/modules/analytics/labels";
import { rangePhrase, resolveRange, shortDay, spanLabel } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { ANY_EVENT, RETENTION_DAYS, retention, topEvents } from "@/modules/analytics/service";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Retention") };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The accent color, stronger with the rate, so the table reads as a heat map (in either theme). */
function cell(rate: number | null) {
  if (rate === null) return { className: "text-ink-3", style: undefined };
  // Paper-colored text only where the cell is strong enough for it in both themes (about 4:1).
  return { className: rate >= 0.7 ? "text-paper" : "text-ink", style: { background: `color-mix(in oklab, var(--color-accent) ${Math.round(10 + rate * 85)}%, transparent)` } };
}

export default async function RetentionPage(props: PageProps<"/o/[org]/apps/[app]/analytics/retention">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const [t, lang] = await Promise.all([getT(), getLang()]);
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
  const label = await eventLabels(ctx, a.id, t);

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Retention")} description={t("Of the people who did a start event on a given day, how many came back and did the return event N days later.")} env={env.type} />
      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("That audience is archived or no longer exists in this environment, so the report shows everyone.")}</p>}
      {!r ? (
        <div className="card"><p>{t("No events in this environment in {range}.", { range: rangePhrase(resolveRange(range, a.timezone), t, lang) })}</p><ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/retention`} sp={sp} className="mt-3" /></div>
      ) : (
        <>
          <form method="get" className="filters">
            <input type="hidden" name="env" value={env.type} />
            <AutoApply />
            <label className="wide"><span className="label">{t("Start event")}</span>
              <select name="start" className="input" defaultValue={startEvent}>{names.map((n) => <option key={n} value={n}>{label(n)}</option>)}</select>
            </label>
            <label className="wide"><span className="label">{t("Return event")}</span>
              <select name="return" className="input" defaultValue={returnEvent}><option value={ANY_EVENT}>{t("Any event")}</option>{names.map((n) => <option key={n} value={n}>{label(n)}</option>)}</select>
            </label>
            <ReportRangeFields label={t("Cohorts from")} range={r.range} compare={false} />
            <MoreFilters open={Boolean(param(sp.compare) || cf.cohortId)}>
              <CompareFields range={r.range} />
              <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
            </MoreFilters>
            <button className="btn" type="submit" data-apply>{t("Show")}</button>
            <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/retention`} sp={sp} className="filters-end" />
          </form>

          <section className="card-table">
            <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th className="whitespace-nowrap">{t("Start day")}</th><th className="num">{t("People")}</th>{RETENTION_DAYS.map((d) => <th key={d} className="whitespace-nowrap text-center">{t("Day {n}", { n: d })}</th>)}</tr>
              </thead>
              <tbody>
                <tr className="font-medium">
                  <td className="whitespace-nowrap">{t("All cohorts")}</td>
                  <td className="text-end tabular-nums">{r.people.toLocaleString("en-US")}</td>
                  {r.overall.map((rate, i) => {
                    const c = cell(rate);
                    return (
                      <td key={i} className={`text-center tabular-nums ${c.className}`} style={c.style}>
                        {rate === null ? "–" : pct(rate)}
                        {r.previous && <span className="mt-1 block"><RateDelta value={rate} previous={r.previous[i]} range={r.range} /></span>}
                      </td>
                    );
                  })}
                </tr>
                {r.cohorts.map((co) => (
                  <tr key={co.day}>
                    <td className="whitespace-nowrap">{shortDay(co.day, lang)}</td>
                    <td className="text-end tabular-nums">{co.size.toLocaleString("en-US")}</td>
                    {co.returned.map((n, i) => {
                      const rate = n === null ? null : n / co.size;
                      const c = cell(rate);
                      return <td key={i} className={`text-center tabular-nums ${c.className}`} style={c.style} data-heat={n === null ? undefined : ""} title={n === null ? t("Not reached yet") : t("{n} of {size}", { n, size: co.size })}>{rate === null ? "" : pct(rate)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
          <p className="text-xs text-ink-3">{t("People are grouped by the day of their first start event in the range ({timezone}). Day N counts people who did the return event on that calendar day; Activation uses the same rule for its D1, D7 and D30. Empty cells are days that aren't over yet.", { timezone: a.timezone })}{r.range.previous && <> {t("Changes are against cohorts from {period}.", { period: spanLabel(r.range.previous.from, r.range.previous.to, lang) })}</>}{cf.cohortName && <> {t("Only people in the audience {audience}.", { audience: cf.cohortName })}</>}</p>
          {cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="retention" query={{ ...sp, start: startEvent, return: returnEvent }} />}
        </>
      )}
    </div>
  );
}
