import Link from "next/link";
import { AutoApply } from "@/components/AutoApply";
import { AnalyticsHeader, param, rich } from "@/components/AnalyticsHeader";
import { getLang, getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";
import { CohortSelect } from "@/components/CohortSelect";
import { Delta, ReportRangeFields } from "@/components/ReportRange";
import { SaveReport } from "@/components/SaveReport";
import { CountUp } from "@/components/CountUp";
import { TrendChart } from "@/components/TrendChart";
import { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN, NO_CURRENCY, REVENUE_BREAKDOWNS, revenueReport } from "@/modules/analytics/revenue";
import { FALLBACK_PROPERTY } from "@/modules/analytics/revenue-rules";
import { rangeLabel, rangePhrase } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { ReportFreshness } from "@/components/ReportFreshness";
import { cohortFilter, reportRunner } from "@/server/analytics-page";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Revenue") };
}

const BREAKDOWN_LABELS: Record<string, string> = { platform: msg("Platform"), event: msg("Event"), channel: msg("Channel") };
const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source"), [CHANNEL_NO_INSTALL]: msg("No install on record") };
const INTERVAL_NAMES: Record<string, string> = { day: msg("day"), week: msg("week"), month: msg("month") };
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cur = (t: T, c: string) => (c === NO_CURRENCY ? t("No currency") : c);

export default async function RevenuePage(props: PageProps<"/o/[org]/apps/[app]/analytics/revenue">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const [t, lang] = await Promise.all([getT(), getLang()]);
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
        title={t("Revenue")}
        description={t("Revenue from your revenue events, per currency, with refunds subtracted. Days are in the app's timezone.")} env={env.type}
      />
      <ReportFreshness info={reports.info} path={`/o/${org}/apps/${app}/analytics/revenue`} sp={sp} />

      <form method="get" className="card flex flex-wrap items-end gap-3">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <label><span className="label">{t("Break down by")}</span>
          <select name="by" className="input" defaultValue={by ?? ""}>
            <option value="">{t("Nothing")}</option>
            {REVENUE_BREAKDOWNS.map((b) => <option key={b} value={b}>{t(BREAKDOWN_LABELS[b])}</option>)}
            <option value="property">{t("Event property…")}</option>
          </select>
        </label>
        <label><span className="label">{t("Property")}</span><input name="property" className="input w-40" defaultValue={property ?? ""} placeholder={t("e.g. {example}", { example: "product_id" })} maxLength={64} /></label>
        <CohortSelect cohorts={cf.cohorts} value={cf.cohortId} />
        <ReportRangeFields range={r.range} interval={r.interval} />
        <button className="btn" type="submit" data-apply>{t("Show")}</button>
      </form>

      {cf.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("That audience is archived or no longer exists in this environment, so the report shows everyone.")}</p>}

      <p className="rounded-lg bg-paper-2 px-3 py-2 text-sm text-ink-2">
        {t("Amounts are shown in the currency each event was sent in. There is no currency conversion, so each currency is totalled separately and never added to another.")}
      </p>

      {r.currencies.length === 0 ? (
        <div className="card space-y-1">
          <p>{cf.cohortName
            ? t("No revenue from the audience {audience} in {range}.", { audience: cf.cohortName, range: rangePhrase(r.range, t, lang) })
            : t("No revenue in this environment in {range}.", { range: rangePhrase(r.range, t, lang) })}</p>
          <p className="text-sm text-ink-3">
            {rich(t("Revenue comes from events like {event} with a {revenue} and a {currency} property, sent from your backend once payment is confirmed."), {
              event: <span className="font-mono" dir="ltr">purchase_completed</span>,
              revenue: <span className="font-mono" dir="ltr">revenue</span>,
              currency: <span className="font-mono" dir="ltr">currency</span>,
            })}
            {can(ctx.role, "implementation.read") && rich(t("See the {plan}."), { plan: <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/implementation/plan`}>{t("tracking plan")}</Link> })}
          </p>
        </div>
      ) : (
        <>
          {r.currencies.map((c) => (
            <section key={c.currency} className="card space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="h2">{cur(t, c.currency)} <span className="text-xs font-normal text-ink-3">{rangeLabel(r.range, t, lang)}</span></h2>
                {c.currency === NO_CURRENCY && <span className="text-xs text-warn">{t("These events had no valid ISO 4217 currency code.")}</span>}
              </div>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
                <Stat label={t("Net revenue")} value={money(c.net)} strong delta={<Delta value={c.net} previous={r.previous ? (r.previous.find((x) => x.currency === c.currency)?.net ?? 0) : null} range={r.range} format={money} />} />
                <Stat label={t("Gross")} value={money(c.gross)} />
                <Stat label={t("Refunds")} value={c.refunds ? `−${money(c.refunds)}` : "0.00"} hint={c.refundCount ? t("{n} refunds", { n: c.refundCount }) : undefined} />
                <Stat label={t("Transactions")} value={c.transactions.toLocaleString("en-US")} />
                <Stat label={t("Paying people")} value={c.payingUsers.toLocaleString("en-US")} />
                <Stat label="ARPPU" value={money(c.arppu)} hint={t("Net per paying person")} />
                <Stat label="ARPU" value={money(c.arpu)} hint={t("Net per active person ({n})", { n: r.activeUsers.toLocaleString("en-US") })} />
              </dl>
              {r.daily.find((d) => d.key === c.currency) && (
                <TrendChart days={r.days} series={[r.daily.find((d) => d.key === c.currency)!]} label={t("Net {currency} revenue per {interval}", { currency: cur(t, c.currency), interval: t(INTERVAL_NAMES[r.interval] ?? r.interval) })} />
              )}
            </section>
          ))}

          {r.breakdown && (
            <section className="card overflow-x-auto p-0">
              {r.breakdownBy === "channel" && (
                <p className="px-5 pt-4 text-sm text-ink-3">{t("Channel is where each paying person came from: the source of their latest install before the purchase, as in Acquisition.")}</p>
              )}
              <table className="table">
                <thead>
                  <tr>
                    <th className="text-start">{r.breakdownBy?.startsWith("property:") ? r.breakdownBy.slice(9) : t(BREAKDOWN_LABELS[r.breakdownBy ?? ""] ?? "")}</th>
                    <th className="text-start">{t("Currency")}</th>
                    <th className="text-end">{t("Gross")}</th><th className="text-end">{t("Refunds")}</th><th className="text-end">{t("Net")}</th><th className="text-end">{t("Paying people")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.breakdown.map((g) => (
                    <tr key={`${g.currency}-${g.key}`}>
                      <td className="font-mono text-sm">{g.key === "(none)" ? t("(none)") : r.breakdownBy === "channel" && CHANNEL_LABELS[g.key] ? t(CHANNEL_LABELS[g.key]) : g.key}</td>
                      <td>{cur(t, g.currency)}</td>
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
        <summary className="cursor-pointer font-medium">{t("What counts as revenue")}</summary>
        <div className="mt-3 space-y-3 text-ink-2">
          <p>
            {rich(t("Events your published tracking plan marks as revenue, then the standard revenue events below, then any other event with a numeric {property} property."), { property: <span className="font-mono" dir="ltr">{FALLBACK_PROPERTY}</span> })}{" "}
            {rich(t("A transaction is counted once per event and {id}. Refunds are subtracted on the day they happen, in their own currency. Weeks start on Monday."), { id: <span className="font-mono" dir="ltr">transaction_id</span> })}{" "}
            {t("Paying people did at least one revenue event in the range; ARPU divides net revenue by everyone active in the range.")}
          </p>
          <table className="table">
            <thead><tr><th className="text-start">{t("Event")}</th><th className="text-start">{t("Amount property")}</th><th className="text-start">{t("Counts as")}</th><th className="text-start">{t("From")}</th></tr></thead>
            <tbody>
              {r.rules.map((rule) => (
                <tr key={rule.event}>
                  <td className="font-mono">{rule.event}</td>
                  <td className="font-mono">{rule.property}</td>
                  <td>{rule.kind === "refund" ? t("Refund (subtracted)") : t("Revenue")}</td>
                  <td className="text-ink-3">{rule.source === "plan" ? t("Your tracking plan") : t("Standard catalog")}</td>
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
      <dd className={`tabular-nums ${strong ? "text-xl font-bold" : "text-lg"}`}><CountUp value={value} /></dd>
      {delta && <dd>{delta}</dd>}
      {hint && <dd className="text-xs text-ink-3">{hint}</dd>}
    </div>
  );
}
