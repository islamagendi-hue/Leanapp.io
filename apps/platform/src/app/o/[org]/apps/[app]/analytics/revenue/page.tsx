import Link from "next/link";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { CohortSelect } from "@/components/CohortSelect";
import { Delta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { TrendChart } from "@/components/TrendChart";
import { NO_CURRENCY, REVENUE_BREAKDOWNS, revenueReport } from "@/modules/analytics/revenue";
import { FALLBACK_PROPERTY } from "@/modules/analytics/revenue-rules";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Revenue" };

const BREAKDOWN_LABELS: Record<string, string> = { platform: "Platform", event: "Event" };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur = (c: string) => (c === NO_CURRENCY ? "No currency" : c);

export default async function RevenuePage(props: PageProps<"/o/[org]/apps/[app]/analytics/revenue">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const range = rangeFromParams(toSearch(sp));
  const by = param(sp.by);
  const property = param(sp.property)?.trim();
  const breakdown = by === "property" && property ? `property:${property}` : by || undefined;
  const cf = await cohortFilter(ctx, env.id, sp.cohort);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const reports = reportRunner(ctx, scope, sp);
  const revenueInput = { ...range, interval: param(sp.interval), breakdown, cohortId: cf.cohortId };
  const r = await reports.run("revenue", revenueInput, () => revenueReport(ctx, scope, revenueInput));

  return (
    <div className="space-y-6">
      <AnalyticsHeader
        title="Revenue"
        description="Revenue from your revenue events, per currency, with refunds subtracted. Days are in the app's timezone." env={env.type}
      />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/revenue`} sp={sp} />

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <input type="hidden" name="env" value={env.type} />
        <label><span className="label">Break down by</span>
          <select name="by" className="input" defaultValue={by ?? ""}>
            <option value="">Nothing</option>
            {REVENUE_BREAKDOWNS.map((b) => <option key={b} value={b}>{BREAKDOWN_LABELS[b]}</option>)}
            <option value="property">Event property…</option>
          </select>
        </label>
        <label><span className="label">Property</span><input name="property" className="input w-40" defaultValue={property ?? ""} placeholder="e.g. product_id" maxLength={64} /></label>
        <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
        <ReportRangeFields range={r.range} interval={r.interval} />
        <button className="btn" type="submit">Show</button>
      </form>

      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">That audience is archived or no longer exists in this environment, so the report shows everyone.</p>}

      <p className="rounded-lg bg-paper-2 px-3 py-2 text-sm text-ink-2">
        Amounts are shown in the currency each event was sent in. There is no currency conversion, so each currency is totalled separately and never added to another.
      </p>

      {r.currencies.length === 0 ? (
        <div className="card space-y-1">
          <p>No revenue {cf.cohortName ? `from the audience ${cf.cohortName}` : "in this environment"} in {r.range.preset ? `the ${r.range.label.toLowerCase()}` : r.range.label}.</p>
          <p className="text-sm text-ink-3">
            Revenue comes from events like <span className="font-mono">purchase_completed</span> with a <span className="font-mono">revenue</span> and a <span className="font-mono">currency</span> property, sent from your backend once payment is confirmed.
            {can(ctx.role, "implementation.read") && <>See the <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/implementation/plan`}>tracking plan</Link>.</>}
          </p>
        </div>
      ) : (
        <>
          {r.currencies.map((c) => (
            <section key={c.currency} className="card space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="h2">{cur(c.currency)} <span className="text-xs font-normal text-ink-3">{r.range.label}</span></h2>
                {c.currency === NO_CURRENCY && <span className="text-xs text-warn">These events had no valid ISO 4217 currency code.</span>}
              </div>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label="Net revenue" value={money(c.net)} strong delta={<Delta value={c.net} previous={r.previous ? (r.previous.find((x) => x.currency === c.currency)?.net ?? 0) : null} range={r.range} format={money} />} />
                <Stat label="Gross" value={money(c.gross)} />
                <Stat label="Refunds" value={c.refunds ? `−${money(c.refunds)}` : "0.00"} hint={c.refundCount ? `${c.refundCount} refunds` : undefined} />
                <Stat label="Transactions" value={c.transactions.toLocaleString("en-US")} />
                <Stat label="Paying people" value={c.payingUsers.toLocaleString("en-US")} />
                <Stat label="ARPPU" value={money(c.arppu)} hint="Net per paying person" />
                <Stat label="ARPU" value={money(c.arpu)} hint={`Net per active person (${r.activeUsers.toLocaleString("en-US")})`} />
              </dl>
              {r.daily.find((d) => d.key === c.currency) && (
                <TrendChart days={r.days} series={[r.daily.find((d) => d.key === c.currency)!]} label={`Net ${cur(c.currency)} revenue per ${r.interval}`} />
              )}
            </section>
          ))}

          {r.breakdown && (
            <section className="card overflow-x-auto p-0">
              <table className="table">
                <thead>
                  <tr>
                    <th className="text-start">{r.breakdownBy?.startsWith("property:") ? r.breakdownBy.slice(9) : BREAKDOWN_LABELS[r.breakdownBy ?? ""]}</th>
                    <th className="text-start">Currency</th>
                    <th className="text-end">Gross</th><th className="text-end">Refunds</th><th className="text-end">Net</th><th className="text-end">Paying people</th>
                  </tr>
                </thead>
                <tbody>
                  {r.breakdown.map((g) => (
                    <tr key={`${g.currency}-${g.key}`}>
                      <td className="font-mono text-sm">{g.key}</td>
                      <td>{cur(g.currency)}</td>
                      <td className="text-end tabular-nums">{money(g.gross)}</td>
                      <td className="text-end tabular-nums">{g.refunds ? `−${money(g.refunds)}` : ""}</td>
                      <td className="text-end tabular-nums font-medium">{money(g.net)}</td>
                      <td className="text-end tabular-nums">{g.payingUsers.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {cf.canSave && <SaveReport org={org} app={app} environmentId={env.id} kind="revenue" query={sp} />}
        </>
      )}

      <details className="card text-sm">
        <summary className="cursor-pointer font-medium">What counts as revenue</summary>
        <div className="mt-3 space-y-3 text-ink-2">
          <p>
            Events your published tracking plan marks as revenue, then the standard revenue events below, then any other event with a numeric <span className="font-mono">{FALLBACK_PROPERTY}</span> property.
            A transaction is counted once per event and <span className="font-mono">transaction_id</span>. Refunds are subtracted on the day they happen, in their own currency. Weeks start on Monday.
            Paying people did at least one revenue event in the range; ARPU divides net revenue by everyone active in the range.
          </p>
          <table className="table">
            <thead><tr><th className="text-start">Event</th><th className="text-start">Amount property</th><th className="text-start">Counts as</th><th className="text-start">From</th></tr></thead>
            <tbody>
              {r.rules.map((rule) => (
                <tr key={rule.event}>
                  <td className="font-mono">{rule.event}</td>
                  <td className="font-mono">{rule.property}</td>
                  <td>{rule.kind === "refund" ? "Refund (subtracted)" : "Revenue"}</td>
                  <td className="text-ink-3">{rule.source === "plan" ? "Your tracking plan" : "Standard catalog"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value, hint, strong, delta }: { label: string; value: string; hint?: string; strong?: boolean; delta?: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className={`tabular-nums ${strong ? "text-xl font-bold" : "text-lg"}`}>{value}</dd>
      {delta && <dd>{delta}</dd>}
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );
}
