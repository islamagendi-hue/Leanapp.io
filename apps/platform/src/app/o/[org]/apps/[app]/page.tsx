import Link from "next/link";
import { param } from "@/components/AnalyticsHeader";
import { WidgetView } from "@/components/dashboards/WidgetView";
import { Delta } from "@/components/ReportRange";
import { ReportFreshness } from "@/components/ReportFreshness";
import { TrendChart } from "@/components/TrendChart";
import { keyFunnelSteps, OVERVIEW_RANGES } from "@/modules/analytics/overview";
import { revenueReport } from "@/modules/analytics/revenue";
import { ANY_EVENT, eventTrend, funnel, kpi, retention, topEvents, type Kpi } from "@/modules/analytics/service";
import { environmentHasEvents } from "@/modules/apps/service";
import { growthValue } from "@/modules/dashboards/service";
import { growthOverview } from "@/modules/growth/service";
import { can } from "@/modules/rbac/authorize";
import type { Permission } from "@/modules/rbac/permissions";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment } from "@/server/session";

export const metadata = { title: "Overview" };

const num = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

/**
 * A project's home: the numbers people check first, for the selected
 * environment and the last 7 or 30 days, each compared with the period before.
 * Until production receives its first event it says so and points to
 * Settings → Dev Ops → Get started. Every number comes from the same reports
 * as Analytics (and their result cache), never a separate calculation.
 */
export default async function OverviewPage(props: PageProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  const production = environments.find((e) => e.type === "production");
  const live = production ? await environmentHasEvents(ctx, production.id) : false;
  const env = await pickEnvironment(environments, sp.env);
  const days = param(sp.days) === "30" ? 30 : 7;

  const sections: { label: string; href: string; text: string; perm: Permission }[] = [
    { label: "Events & trends", href: `${base}/analytics/events`, text: "How often each event happens and how many people do it.", perm: "analytics.read" },
    { label: "Funnels", href: `${base}/analytics/funnels`, text: "Conversion through ordered steps.", perm: "analytics.read" },
    { label: "Retention", href: `${base}/analytics/retention`, text: "Who comes back after day 1, 7 and 30.", perm: "analytics.read" },
    { label: "Dashboards", href: `${base}/analytics/dashboards`, text: "Reports and numbers you check together.", perm: "analytics.read" },
    { label: "Users", href: `${base}/analytics/users`, text: "One person's profile and full timeline.", perm: "users.read" },
    { label: "Audiences", href: `${base}/engage/audiences`, text: "Reusable groups of people to analyse and reach.", perm: "audiences.read" },
  ];
  const visible = sections.filter((s) => can(ctx.role, s.perm));
  const metrics = can(ctx.role, "analytics.read") ? await overview(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone }, days, sp) : null;
  const rangeLink = (d: number) => `${base}?${new URLSearchParams({ env: env.type, days: String(d) })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Overview</h1>
          <p className="mt-1 text-ink-2">{a.name}{a.description ? `: ${a.description}` : ""}</p>
        </div>
        {metrics && (
          <nav className="flex gap-2" aria-label="Range">
            {OVERVIEW_RANGES.map((d) => (
              <Link key={d} href={rangeLink(d)} aria-current={d === days ? "page" : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${d === days ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2"}`}>
                Last {d} days
              </Link>
            ))}
          </nav>
        )}
      </div>

      {!live && (
        <section className="card flex flex-wrap items-center justify-between gap-4 border-accent/40 bg-accent-soft">
          <div>
            <h2 className="h2">Connect your app</h2>
            <p className="mt-1 max-w-xl text-sm text-ink-2">
              Production hasn&apos;t received any events yet. Install the SDK and send your first event; your reports fill in as data arrives.
            </p>
          </div>
          {can(ctx.role, "implementation.read") && <Link href={`${base}/settings/dev-ops/get-started`} className="btn">Get started</Link>}
        </section>
      )}

      {metrics && (metrics.empty ? (
        <p className="card text-sm text-ink-2">No events in <strong>{env.type}</strong> in the last {days} days yet.</p>
      ) : (
        <>
          <p className="text-xs text-ink-3">Showing <strong>{env.type}</strong>, compared with the {days} days before.</p>
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Key numbers">
            <Tile label="Active users" k={metrics.active} />
            <Tile label="New users" k={metrics.fresh} />
            <Tile label="Events" k={metrics.events} />
          </section>

          <section className="card space-y-2">
            <h2 className="h2">Active users per day</h2>
            <TrendChart days={metrics.trend.days} series={[{ key: "Active users", counts: metrics.trend.series[0]?.people ?? metrics.trend.days.map(() => 0) }]} label="Active users per day" />
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Activation</h2>
                {can(ctx.role, "growth.read") && <Link className="text-sm underline" href={`${base}/growth?env=${env.type}`}>Open</Link>}
              </div>
              {metrics.activation === undefined ? <p className="text-sm text-ink-3">You don&apos;t have access to Activation.</p>
                : metrics.activation === null ? <p className="text-sm text-ink-3">Activation isn&apos;t turned on. Define what an activated user does to see the rate here.</p>
                : (
                  <div className="grid grid-cols-2 gap-3">
                    <div><p className="text-3xl font-bold tabular-nums">{pct(metrics.activation.rate)}</p><p className="text-xs text-ink-3">activation rate (all time)</p></div>
                    <div><p className="text-3xl font-bold tabular-nums">{num(metrics.activation.activated)}</p><p className="text-xs text-ink-3">activated people</p></div>
                  </div>
                )}
            </section>

            <section className="card space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Retention</h2>
                <Link className="text-sm underline" href={`${base}/analytics/retention?${new URLSearchParams({ env: env.type, days: "30" })}`}>Open</Link>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                {(["D1", "D7", "D30"] as const).map((label, i) => (
                  <div key={label}><p className="text-xs text-ink-3">{label}</p><p className="text-2xl font-bold tabular-nums">{pct(metrics.retention.overall[[0, 2, 4][i]])}</p></div>
                ))}
              </div>
              <p className="text-xs text-ink-3">People active on a day in the last 30 days who came back exactly 1, 7 or 30 days later. Days that aren&apos;t over yet aren&apos;t counted.</p>
            </section>

            <section className="card space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Key funnel</h2>
                {metrics.funnelSteps && <Link className="text-sm underline" href={`${base}/analytics/funnels?${new URLSearchParams([["env", env.type], ["days", String(days)], ...metrics.funnelSteps.map((s) => ["step", s])])}`}>Open</Link>}
              </div>
              {metrics.funnel ? <WidgetView result={{ ok: true, data: { type: "funnel", funnel: metrics.funnel } }} /> : (
                <p className="text-sm text-ink-3">
                  The key funnel follows your Activation steps. {can(ctx.role, "growth.read") ? <>Define them in <Link className="underline" href={`${base}/growth?env=${env.type}`}>Activation</Link>, or build any funnel in <Link className="underline" href={`${base}/analytics/funnels?env=${env.type}`}>Funnels</Link>.</> : null}
                </p>
              )}
            </section>

            <section className="card space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Top events</h2>
                <Link className="text-sm underline" href={`${base}/analytics/events?${new URLSearchParams({ env: env.type, days: String(days) })}`}>Open</Link>
              </div>
              <table className="table">
                <thead><tr><th className="text-start">Event</th><th className="text-end">Count</th><th className="text-end">People</th></tr></thead>
                <tbody>
                  {metrics.top.slice(0, 6).map((e) => (
                    <tr key={e.name}><td className="truncate font-mono text-sm">{e.name}</td><td className="text-end tabular-nums">{num(e.count)}</td><td className="text-end tabular-nums">{num(e.people)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {metrics.revenue && metrics.revenue.currencies.length > 0 && (
            <section className="card space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="h2">Revenue</h2>
                <Link className="text-sm underline" href={`${base}/analytics/revenue?${new URLSearchParams({ env: env.type, days: String(days) })}`}>Open</Link>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {metrics.revenue.currencies.slice(0, 3).map((c) => (
                  <div key={c.currency}>
                    <p className="text-2xl font-bold tabular-nums">{c.net.toLocaleString("en-US", { maximumFractionDigits: 2 })} <span className="text-sm font-normal">{c.currency}</span></p>
                    <Delta value={c.net} previous={metrics.revenue!.previous?.find((p) => p.currency === c.currency)?.net ?? 0} range={metrics.revenue!.range} />
                    <p className="text-xs text-ink-3">{num(c.payingUsers)} paying · ARPU {c.arpu.toLocaleString("en-US", { maximumFractionDigits: 2 })}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          <ReportFreshness info={metrics.freshness} path={base} sp={sp} />
        </>
      ))}

      {visible.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((s) => (
            <Link key={s.href} href={s.href} className="card block hover:border-line-strong">
              <p className="font-medium">{s.label}</p>
              <p className="mt-1 text-sm text-ink-3">{s.text}</p>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}

function Tile({ label, k }: { label: string; k: Kpi }) {
  return (
    <div className="card">
      <p className="label">{label}</p>
      <p className="text-3xl font-bold tabular-nums">{num(k.value)}</p>
      <Delta value={k.value} previous={k.previous} range={k.range} />
    </div>
  );
}

type Ctx = Awaited<ReturnType<typeof loadApp>>["ctx"];

/** Every Overview number, each through the report result cache. */
async function overview(ctx: Ctx, scope: { appId: string; environmentId: string; timezone: string }, days: number, sp: Record<string, string | string[] | undefined>) {
  const env = { environmentId: scope.environmentId, timezone: scope.timezone };
  const reports = reportRunner(ctx, env, sp);
  const period = { days, compare: true };
  const k = (metric: string) => {
    const input = { metric, ...period };
    return reports.run("kpi", input, () => kpi(ctx, env, input));
  };
  const [active, fresh, events] = await Promise.all([k("active_people"), k("new_people"), k("all_events")]);
  const freshness = reports.info;
  if (events.value === 0 && active.value === 0) return { empty: true as const, freshness };

  const trendInput = { event: ANY_EVENT, days, interval: "day" };
  const retentionInput = { startEvent: ANY_EVENT, returnEvent: ANY_EVENT, days: 30 };
  const [trend, top, ret, revenue] = await Promise.all([
    reports.run("trend", trendInput, () => eventTrend(ctx, env, trendInput)),
    reports.run("top_events", { days }, () => topEvents(ctx, { ...env, days })),
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
  const funnelInput = funnelSteps ? { steps: funnelSteps, windowDays: 7, days } : null;
  const keyFunnel = funnelInput ? await reports.run("funnel", funnelInput, () => funnel(ctx, env, funnelInput)) : null;

  return { empty: false as const, active, fresh, events, trend, top, retention: ret, revenue, activation, funnelSteps, funnel: keyFunnel, freshness };
}
