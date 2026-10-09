import Link from "next/link";
import { AutoApply } from "@/components/AutoApply";
import { AnalyticsHeader, param, rich } from "@/components/AnalyticsHeader";
import { getLang, getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";
import { EventName } from "@/components/EventName";
import { CohortSelect } from "@/components/CohortSelect";
import { PropertyFilters } from "@/components/PropertyFilters";
import { CompareFields, Delta, MoreFilters, ReportRangeFields } from "@/components/ReportRange";
import { Stat } from "@/components/Stat";
import { SaveReport } from "@/components/SaveReport";
import { TrendChart } from "@/components/TrendChart";
import { eventLabels } from "@/modules/analytics/labels";
import { rangeLabel, rangePhrase, spanLabel } from "@/modules/analytics/range";
import { eventFiltersFromParams, rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { ANY_EVENT, BREAKDOWNS, eventTrend, kpi, MAX_EVENT_FILTERS, topEvents } from "@/modules/analytics/service";
import { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { catalogForPickers, options } from "@/modules/properties/catalog";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Events") };
}

const BREAKDOWN_LABELS: Record<string, string> = { platform: msg("Platform"), app_version: msg("App version"), country: msg("Country"), channel: msg("Channel") };
const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source"), [CHANNEL_NO_INSTALL]: msg("No install on record") };
const INTERVAL_NAMES: Record<string, string> = { day: msg("day"), week: msg("week"), month: msg("month") };
/** Series names the report makes up ("Other", "(none)"); values people sent stay as they are. */
const seriesName = (t: T, key: string, by?: string | null) =>
  key === "Other" ? t("Other") : key === "(none)" ? t("(none)") : by === "channel" && CHANNEL_LABELS[key] ? t(CHANNEL_LABELS[key]) : key;
const num = (n: number) => n.toLocaleString("en-US");

export default async function EventsPage(props: PageProps<"/o/[org]/apps/[app]/analytics/events">) {
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
  const listInput = { ...range, cohortId: cf.cohortId };
  const events = await reports.run("top_events", listInput, () => topEvents(ctx, { ...scope, ...listInput }));
  const selected = param(sp.event) ?? events[0]?.name;
  const label = await eventLabels(ctx, a.id, t);
  const property = param(sp.property)?.trim();
  const by = param(sp.by);
  const breakdown = by === "property" && property ? `property:${property}` : by;
  const { filters, parts } = eventFiltersFromParams(toSearch(sp));
  const trendInput = { event: selected, ...range, interval: param(sp.interval), breakdown, where: filters.length ? filters : undefined, cohortId: cf.cohortId };
  const trend = selected ? await reports.run("trend", trendInput, () => eventTrend(ctx, scope, trendInput)) : null;
  // Event properties from the shared catalog: the ones seen on (or planned for) this event, else all of them.
  const eventProps = options((await catalogForPickers(ctx, { appId: a.id, environmentId: env.id }, "analytics.read", { only: "event" })).event);
  const onEvent = eventProps.filter((o) => selected && o.events?.includes(selected));
  const propOptions = onEvent.length ? onEvent : eventProps;
  const activeInput = { metric: "active_people", ...range, cohortId: cf.cohortId };
  const active = await reports.run("kpi", activeInput, () => kpi(ctx, scope, activeInput));
  const path = `/o/${org}/apps/${app}/analytics/events`;
  const keep = new URLSearchParams(
    Object.entries({ env: env.type, days: param(sp.days), from: param(sp.from), to: param(sp.to), compare: param(sp.compare), cfrom: param(sp.cfrom), cto: param(sp.cto), interval: param(sp.interval), cohort: cf.cohortId })
      .filter((e): e is [string, string] => !!e[1]),
  );
  const link = (name: string) => `${path}?${new URLSearchParams([...keep, ["event", name]])}`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Events")} description={t("How often each event happens and how many people do it, per day in the app's timezone.")} env={env.type} />
      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("That audience is archived or no longer exists in this environment, so the report shows everyone.")}</p>}
      {events.length === 0 ? (
        <div className="card">
          <p>{cf.cohortName
            ? t("No events for the audience {audience} in {range}.", { audience: cf.cohortName, range: rangePhrase(active.range, t, lang) })
            : t("No events in this environment in {range}.", { range: rangePhrase(active.range, t, lang) })}</p>
          {cf.cohortName && <p className="mt-1 text-sm"><Link className="underline" href={`${path}?${new URLSearchParams([...keep].filter(([k]) => k !== "cohort"))}`}>{t("Show everyone instead")}</Link></p>}
          <p className="mt-1 text-sm text-ink-3">
            {t("Events appear here as soon as your app sends them.")}
            {can(ctx.role, "events.read") && <> {rich(t("Check the {debugger}."), { debugger: <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/debugger?env=${env.type}`}>{t("event debugger")}</Link> })}</>}
          </p>
          <ReportFreshness info={reports.info} path={path} sp={sp} className="mt-3" />
        </div>
      ) : (
        <>
          <form method="get" className="filters">
            <input type="hidden" name="env" value={env.type} />
            <AutoApply />
            <label className="wide"><span className="label">{t("Event")}</span>
              <select name="event" className="input" defaultValue={selected}>
                <option value={ANY_EVENT}>{t("Any event (all activity)")}</option>
                {events.map((e) => <option key={e.name} value={e.name}>{label(e.name)}</option>)}
              </select>
            </label>
            <label><span className="label">{t("Split by")}</span>
              <select name="by" className="input" defaultValue={by ?? ""}>
                <option value="">{t("Nothing")}</option>
                {BREAKDOWNS.map((b) => <option key={b} value={b}>{t(BREAKDOWN_LABELS[b])}</option>)}
                <option value="property">{t("Event property…")}</option>
              </select>
            </label>
            <label><span className="label">{t("Property")}</span>
              <select name="property" className="input" defaultValue={property ?? ""}>
                <option value="">{t("Choose…")}</option>
                {property && !propOptions.some((o) => o.name === property) && <option value={property}>{property}</option>}
                {propOptions.map((o) => <option key={o.name} value={o.name} title={o.description || undefined}>{o.name}</option>)}
              </select>
            </label>
            <ReportRangeFields range={active.range} interval={trend?.interval} compare={false} />
            <MoreFilters open={Boolean(param(sp.compare) || cf.cohortId || parts.length)}>
              <CompareFields range={active.range} />
              <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
              <PropertyFilters key={selected} options={propOptions} initial={parts} max={MAX_EVENT_FILTERS} label={t("Only events where")} />
            </MoreFilters>
            <button className="btn" type="submit" data-apply>{t("Show")}</button>
            <ReportFreshness info={reports.info} path={path} sp={sp} className="filters-end" />
          </form>

          {trend && (
            <section className="card space-y-4">
              <div className="card-header mb-0">
                <h2 className="card-title"><EventName name={trend.event} labels={label} /></h2>
                <span className="text-xs text-ink-3">{rangeLabel(trend.range, t, lang)}{trend.where.length ? ` · ${trend.where.length > 1 ? t("{n} filters", { n: trend.where.length }) : t("1 filter")}` : ""}{trend.range.previous ? ` · ${t("Compared with {period}", { period: spanLabel(trend.range.previous.from, trend.range.previous.to, lang) })}` : ""}</span>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Kpi label={t("Events")} value={trend.total.count} previous={trend.previous?.count} range={trend.range} />
                <Kpi label={t("People who did it")} value={trend.total.people} previous={trend.previous?.people} range={trend.range} />
                <Kpi label={t("Active people")} value={active.value} previous={active.previous} range={active.range} hint={t("Did any event")} />
              </div>
              <TrendChart days={trend.days} series={trend.series.map((s) => ({ ...s, key: seriesName(t, s.key, trend.breakdown) }))} label={t("{event} per {interval}", { event: label(trend.event), interval: t(INTERVAL_NAMES[trend.interval] ?? trend.interval) })} />
              {trend.interval !== "day" && <p className="text-xs text-ink-3">{trend.interval === "week"
                ? t("Each point is a week starting on the date shown (Monday); the first and last can be partial.")
                : t("Each point is a month starting on the date shown; the first and last can be partial.")}</p>}
              {trend.series.some((s) => s.key === "Other") && <p className="text-xs text-ink-3">{t("The 5 most frequent values are shown; the rest are grouped as Other.")}</p>}
            </section>
          )}

          <section className="card-table">
            <div className="table-scroll">
            <table className="table">
              <thead><tr><th>{t("Event")}</th><th className="num">{t("Events")}</th><th className="num">{t("People")}</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.name}>
                    <td className="text-sm"><Link className={e.name === selected ? "font-bold" : "hover:underline"} href={link(e.name)} scroll={false}><EventName name={e.name} labels={label} /></Link></td>
                    <td className="num">{num(e.count)}</td>
                    <td className="num">{num(e.people)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </section>
          {trend && cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="trend" query={{ ...sp, event: trend.event }} />}
          <p className="text-xs text-ink-3">{t("Mapped events count under their canonical name. Anonymous activity counts toward the user once the install is linked to exactly one user.")}</p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, previous, range, hint }: { label: string; value: number; previous: number | null | undefined; range: Parameters<typeof Delta>[0]["range"]; hint?: string }) {
  return <Stat bare small label={label} value={num(value)} delta={<Delta value={value} previous={previous} range={range} />} note={hint} />;
}
