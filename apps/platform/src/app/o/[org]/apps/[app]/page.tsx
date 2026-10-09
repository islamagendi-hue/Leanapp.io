import Link from "next/link";
import { AutoApply } from "@/components/AutoApply";
import { envName, rich } from "@/components/AnalyticsHeader";
import { WidgetView } from "@/components/dashboards/WidgetView";
import { EventName } from "@/components/EventName";
import { Delta, ReportRangeFields } from "@/components/ReportRange";
import { ReportFreshness } from "@/components/ReportFreshness";
import { Stat } from "@/components/Stat";
import { TrendChart } from "@/components/TrendChart";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { eventLabels } from "@/modules/analytics/labels";
import { keyFunnelSteps } from "@/modules/analytics/overview";
import { spanLabel } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { revenueReport } from "@/modules/analytics/revenue";
import { ANY_EVENT, eventTrend, funnel, kpi, retention, topEvents, type Kpi } from "@/modules/analytics/service";
import { environmentHasEvents } from "@/modules/apps/service";
import { growthValue } from "@/modules/dashboards/service";
import { growthOverview } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import type { Permission } from "@/modules/rbac/permissions";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Overview") };
}

const num = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

/**
 * A project's home: the numbers people check first, for the selected
 * environment and range (the last 7 days unless chosen otherwise), each
 * compared with the period before unless another comparison, or none, is chosen.
 * Until production receives its first event it says so and points to
 * Settings → Dev Ops → Get started: as a full card when there is nothing to
 * show, and as one line above the numbers of another environment that has data. Every number comes from the same reports
 * as Analytics (and their result cache), never a separate calculation.
 */
export default async function OverviewPage(props: PageProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${app}`;
  const production = environments.find((e) => e.type === "production");
  const live = production ? await environmentHasEvents(ctx, production.id) : false;
  const env = await pickEnvironment(environments, sp.env);
  const q = toSearch(sp);
  if (!q.get("days")) q.set("days", "7");
  if (!q.has("compare")) q.set("compare", "1");
  const period = rangeFromParams(q);
  // The range and comparison, carried into every "Open" link.
  const rangeParams = Object.entries(period).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [k, v] as [string, string]);
  if (q.get("days") === "custom") rangeParams.push(["days", "custom"]);
  if (period.compare === true) rangeParams.push(["compare", "1"]);
  const withRange = (path: string, extra: [string, string][] = []) => `${path}?${new URLSearchParams([["env", env.type], ...rangeParams, ...extra])}`;

  const sections: { label: string; href: string; text: string; perm: Permission }[] = [
    { label: msg("Events & trends"), href: `${base}/analytics/events`, text: msg("How often each event happens and how many people do it."), perm: "analytics.read" },
    { label: msg("Funnels"), href: `${base}/analytics/funnels`, text: msg("Conversion through ordered steps."), perm: "analytics.read" },
    { label: msg("Retention"), href: `${base}/analytics/retention`, text: msg("Who comes back after day 1, 7 and 30."), perm: "analytics.read" },
    { label: msg("Dashboards"), href: `${base}/analytics/dashboards`, text: msg("Reports and numbers you check together."), perm: "analytics.read" },
    { label: msg("Users"), href: `${base}/analytics/users`, text: msg("One person's profile and full timeline."), perm: "users.read" },
    { label: msg("Audiences"), href: `${base}/engage/audiences`, text: msg("Reusable groups of people to analyse and reach."), perm: "audiences.read" },
  ];
  const visible = sections.filter((s) => can(ctx.role, s.perm));
  const metrics = can(ctx.role, "analytics.read") ? await overview(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone }, period, sp) : null;
  const label = metrics ? await eventLabels(ctx, a.id, t) : (n: string) => n;
  const envText = <strong>{envName(t, env.type)}</strong>;
  // "last 7 days" (a preset) or the days of a custom range, inside a sentence.
  const span = metrics && (metrics.range.preset ? t("last {n} days", { n: metrics.range.preset }) : spanLabel(metrics.range.from, metrics.range.to, lang));

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Overview")}</h1>
          <p className="mt-1 text-ink-2">{a.name}{a.description ? `: ${a.description}` : ""}</p>
        </div>
        {metrics && (
          <form method="get" className="filters filters-bare max-sm:w-full" aria-label={t("Range")}>
            <input type="hidden" name="env" value={env.type} />
            <AutoApply />
            <ReportRangeFields range={metrics.range} />
            <button className="btn" type="submit" data-apply>{t("Show")}</button>
          </form>
        )}
      </div>

      {!live && metrics && !metrics.empty && env.type !== "production" ? (
        <p className="flex flex-wrap items-center gap-x-2 rounded-lg bg-accent-soft px-3 py-2 text-sm text-ink-2">
          <span>{rich(t("Production isn't receiving events yet; these numbers are from {env}."), { env: envText })}</span>
          {can(ctx.role, "implementation.read") && <Link href={`${base}/settings/dev-ops/get-started`} className="underline">{t("Finish setup")}</Link>}
        </p>
      ) : !live && (
        <section className="card flex flex-wrap items-center justify-between gap-4 border-accent/40 bg-accent-soft">
          <div>
            <h2 className="h2">{t("Connect your app")}</h2>
            <p className="mt-1 max-w-xl text-sm text-ink-2">
              {t("Production hasn't received any events yet. Install the SDK and send your first event; your reports fill in as data arrives.")}
            </p>
          </div>
          {can(ctx.role, "implementation.read") && <Link href={`${base}/settings/dev-ops/get-started`} className="btn">{t("Get started")}</Link>}
        </section>
      )}

      {metrics && (metrics.empty ? (
        <p className="card text-sm text-ink-2">{rich(t("No events in {env} in {range} yet."), { env: envText, range: span })}</p>
      ) : (
        <>
          <p className="text-xs text-ink-3">
            {metrics.range.previous
              ? rich(t("Showing {env}, {range}, compared with {previous}."), { env: envText, range: span, previous: spanLabel(metrics.range.previous.from, metrics.range.previous.to, lang) })
              : rich(t("Showing {env}, {range}."), { env: envText, range: span })}
          </p>
          <section className="stat-grid sm:grid-cols-3" aria-label={t("Key numbers")}>
            <Tile label={t("Active users")} k={metrics.active} />
            <Tile label={t("New users")} k={metrics.fresh} />
            <Tile label={t("Events")} k={metrics.events} />
          </section>

          <section className="card">
            <div className="card-header"><h2 className="card-title">{t("Active users per day")}</h2></div>
            <TrendChart days={metrics.trend.days} series={[{ key: t("Active users"), counts: metrics.trend.series[0]?.people ?? metrics.trend.days.map(() => 0) }]} label={t("Active users per day")} />
          </section>

          {(() => {
            const activation = (
              <section className="card" key="activation">
                <div className="card-header">
                  <h2 className="card-title">{t("Activation")}</h2>
                  {can(ctx.role, "growth.read") && <OpenLink href={`${base}/growth?env=${env.type}`} text={t("Open")} />}
                </div>
                {metrics.activation === undefined ? <p className="text-sm text-ink-3">{t("You don't have access to Activation.")}</p>
                  : metrics.activation === null ? <p className="text-sm text-ink-3">{t("Activation isn't turned on. Define what an activated user does to see the rate here.")}</p>
                  : (
                    <div className="grid grid-cols-2 gap-3">
                      <Stat bare value={pct(metrics.activation.rate)} note={t("activation rate (all time)")} />
                      <Stat bare value={num(metrics.activation.activated)} note={t("activated people")} />
                    </div>
                  )}
              </section>
            );
            const keyFunnel = (
              <section className="card" key="funnel">
                <div className="card-header">
                  <h2 className="card-title">{t("Key funnel")}</h2>
                  {metrics.funnelSteps && <OpenLink href={withRange(`${base}/analytics/funnels`, metrics.funnelSteps.map((s) => ["step", s]))} text={t("Open")} />}
                </div>
                {metrics.funnel ? <WidgetView result={{ ok: true, data: { type: "funnel", funnel: metrics.funnel } }} /> : (
                  <p className="text-sm text-ink-3">
                    {t("The key funnel follows your Activation steps.")} {can(ctx.role, "growth.read") ? rich(t("Define them in {activation}, or build any funnel in {funnels}."), {
                      activation: <Link className="underline" href={`${base}/growth?env=${env.type}`}>{t("Activation")}</Link>,
                      funnels: <Link className="underline" href={`${base}/analytics/funnels?env=${env.type}`}>{t("Funnels")}</Link>,
                    }) : null}
                  </p>
                )}
              </section>
            );
            const retentionCard = (
              <section className="card" key="retention">
                <div className="card-header">
                  <h2 className="card-title">{t("Retention")}</h2>
                  <OpenLink href={`${base}/analytics/retention?${new URLSearchParams({ env: env.type, days: "30" })}`} text={t("Open")} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {(["D1", "D7", "D30"] as const).map((l, i) => (
                    <Stat key={l} bare small label={l} value={pct(metrics.retention.overall[[0, 2, 4][i]])} />
                  ))}
                </div>
                <p className="mt-3 text-xs text-ink-3">{t("People active on a day in the last 30 days who came back exactly 1, 7 or 30 days later. Days that aren't over yet aren't counted.")}</p>
              </section>
            );
            const topEventsCard = (
              <section className="card" key="top">
                <div className="card-header">
                  <h2 className="card-title">{t("Top events")}</h2>
                  <OpenLink href={withRange(`${base}/analytics/events`)} text={t("Open")} />
                </div>
                <table className="table">
                  <thead><tr><th className="text-start">{t("Event")}</th><th className="num">{t("Count")}</th><th className="num">{t("People")}</th></tr></thead>
                  <tbody>
                    {metrics.top.slice(0, 6).map((e) => (
                      <tr key={e.name}><td className="text-sm"><Link className="hover:underline" href={withRange(`${base}/analytics/events`, [["event", e.name]])}><EventName name={e.name} labels={label} /></Link></td><td className="num">{num(e.count)}</td><td className="num">{num(e.people)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
            // Modules that aren't set up yet say so in short cards side by side, instead of
            // stretching next to a full report; the reports with data follow, top aligned.
            const idle = !metrics.funnel && metrics.activation === null;
            return idle ? (
              <>
                <div className="grid items-start gap-4 lg:grid-cols-2">{activation}{keyFunnel}</div>
                <div className="grid items-start gap-4 lg:grid-cols-2">{retentionCard}{topEventsCard}</div>
              </>
            ) : (
              <div className="grid items-start gap-4 lg:grid-cols-2">
                <div className="grid gap-4">{activation}{retentionCard}</div>
                <div className="grid gap-4">{topEventsCard}{keyFunnel}</div>
              </div>
            );
          })()}

          {metrics.revenue && metrics.revenue.currencies.length > 0 && (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">{t("Revenue")}</h2>
                <OpenLink href={withRange(`${base}/analytics/revenue`)} text={t("Open")} />
              </div>
              <div className="stat-grid sm:grid-cols-3">
                {metrics.revenue.currencies.slice(0, 3).map((c) => (
                  <Stat key={c.currency} bare label={t("Net revenue")} value={c.net.toLocaleString("en-US", { maximumFractionDigits: 2 })} unit={c.currency}
                    delta={<Delta value={c.net} previous={metrics.revenue!.previous?.find((p) => p.currency === c.currency)?.net ?? 0} range={metrics.revenue!.range} />}
                    note={t("{paying} paying · ARPU {arpu}", { paying: num(c.payingUsers), arpu: c.arpu.toLocaleString("en-US", { maximumFractionDigits: 2 }) })} />
                ))}
              </div>
            </section>
          )}
          <ReportFreshness info={metrics.freshness} path={base} sp={sp} />
        </>
      ))}

      {visible.length > 0 && (
        <nav aria-label={t("More reports")} className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-4">
          {visible.map((s) => (
            <Link key={s.href} href={s.href} title={t(s.text)} className="link-action text-ink-2">
              {t(s.label)} <span aria-hidden className="inline-block rtl:-scale-x-100">→</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}

/** "Open →" at the end of a card's title row. */
function OpenLink({ href, text }: { href: string; text: string }) {
  return <Link className="link-action" href={href}>{text} <span aria-hidden className="inline-block rtl:-scale-x-100">→</span></Link>;
}

function Tile({ label, k }: { label: string; k: Kpi }) {
  return <Stat label={label} value={num(k.value)} delta={<Delta value={k.value} previous={k.previous} range={k.range} />} />;
}

type Ctx = Awaited<ReturnType<typeof loadApp>>["ctx"];

/** Every Overview number, each through the report result cache. */
async function overview(ctx: Ctx, scope: { appId: string; environmentId: string; timezone: string }, period: ReturnType<typeof rangeFromParams>, sp: Record<string, string | string[] | undefined>) {
  const env = { environmentId: scope.environmentId, timezone: scope.timezone };
  const reports = reportRunner(ctx, env, sp);
  // The span alone, for reports that show no comparison.
  const span = { days: period.days, from: period.from, to: period.to };
  const k = (metric: string) => {
    const input = { metric, ...period };
    return reports.run("kpi", input, () => kpi(ctx, env, input));
  };
  const [active, fresh, events] = await Promise.all([k("active_people"), k("new_people"), k("all_events")]);
  const freshness = reports.info;
  if (events.value === 0 && active.value === 0) return { empty: true as const, freshness, range: active.range };

  const trendInput = { event: ANY_EVENT, ...span, interval: "day" };
  const retentionInput = { startEvent: ANY_EVENT, returnEvent: ANY_EVENT, days: 30 };
  const [trend, top, ret, revenue] = await Promise.all([
    reports.run("trend", trendInput, () => eventTrend(ctx, env, trendInput)),
    reports.run("top_events", span, () => topEvents(ctx, { ...env, ...span })),
    reports.run("retention", retentionInput, () => retention(ctx, env, retentionInput)),
    reports.run("revenue", period, () => revenueReport(ctx, env, period)),
  ]);

  let activation: { rate: number | null; activated: number } | null | undefined;
  let definition = null;
  if (can(ctx.role, "growth.read")) {
    const g = await growthOverview(ctx, scope.appId, scope.environmentId);
    definition = g.definitions.published?.definition ?? null;
    activation = g.enabled && g.summary ? { rate: growthValue(g.summary, "activation_rate").value, activated: g.summary.activated } : null;
  }
  const funnelSteps = keyFunnelSteps(definition, top.map((e) => e.name));
  const funnelInput = funnelSteps ? { steps: funnelSteps, windowDays: 7, ...span } : null;
  const keyFunnel = funnelInput ? await reports.run("funnel", funnelInput, () => funnel(ctx, env, funnelInput)) : null;

  return { empty: false as const, range: active.range, active, fresh, events, trend, top, retention: ret, revenue, activation, funnelSteps, funnel: keyFunnel, freshness };
}
