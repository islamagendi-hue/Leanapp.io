import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num, pct } from "@/components/acquisition/AcquisitionHeader";
import { envName, rich } from "@/components/acquisition/rich";
import { ReportFreshness } from "@/components/ReportFreshness";
import { Stat } from "@/components/Stat";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { channelEconomicsReport } from "@/modules/attribution/economics";
import type { ChannelAmount } from "@/modules/attribution/economics-pure";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("CAC & LTV") };
}

const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source") };
const DASH = "—";
const amount = (v: number | null, currency: string) => (v === null ? DASH : `${money(v)} ${currency}`);

export default async function ChannelEconomicsPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/channels">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  requirePermission(ctx, "analytics.read");
  const env = await pickEnvironment(environments, sp.env);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const range = rangeFromParams(toSearch(sp));
  const input = { days: range.days, from: range.from, to: range.to };
  const reports = reportRunner(ctx, scope, sp);
  const r = await reports.run("channel_economics", input, () => channelEconomicsReport(ctx, scope, input));
  const base = `/o/${org}/apps/${app}/acquisition`;
  const t = await getT();
  const label = (c: string) => (CHANNEL_LABELS[c] ? t(CHANNEL_LABELS[c]) : c);
  const spendTotals = new Map<string, number>();
  for (const c of r.channels) for (const x of c.amounts) if (x.spend !== null) spendTotals.set(x.currency, (spendTotals.get(x.currency) ?? 0) + x.spend);
  const maxUsers = Math.max(1, ...r.channels.map((c) => c.newUsers));
  const anyMismatch = r.channels.some((c) => c.currencyMismatch);
  const spendLink = <Link className="underline" href={`${base}/spend?env=${env.type}`}>{t("Ad spend")}</Link>;

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/channels" env={env.type} title={t("CAC and LTV by channel")}
        description={t("What each channel cost and what its new users paid. LTV is revenue seen so far, not a forecast.")} />
      <AcquisitionRange env={env.type} range={r.range} />

      <section className="stat-grid" aria-label={t("Channel numbers")}>
        <Stat label={t("New users")} value={num(r.totals.newUsers)} note={t("First install in this range")} />
        <Stat label={t("Paying users")} value={num(r.totals.payingUsers)} note={t("{pct} of new users", { pct: pct(r.totals.payingUsers, r.totals.newUsers) })} />
        <Stat label={t("Spend")} value={spendTotals.size ? [...spendTotals].map(([c, v]) => `${money(v)} ${c}`).join(" · ") : DASH} small={spendTotals.size > 1}
          note={spendTotals.size ? t("Entered on the Ad spend page") : t("No spend entered for this range")} />
      </section>

      {r.channels.length === 0 ? (
        <div className="card space-y-2">
          <p>{t("No new users or spend in {env} for the selected range of dates.", { env: envName(t, env.type) })}</p>
          <p className="max-w-2xl text-sm text-ink-3">{rich(t("New users come from installs your app reports. Enter costs on the {spend} page."), { spend: spendLink })}</p>
        </div>
      ) : (
        <>
          <section className="card space-y-3">
            <h2 className="h2">{t("New users by channel")}</h2>
            <p className="text-sm text-ink-3">{t("The full bar is new users. The dark part is those who paid.")}</p>
            {r.totals.newUsers === 0 && <p className="text-sm text-ink-2">{t("No new users in this range.")}</p>}
            <ul className="space-y-2" data-testid="channel-bars">
              {r.channels.filter((c) => c.newUsers > 0).map((c) => (
                <li key={c.channel} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate">{label(c.channel)}</span>
                  <span className="relative block h-4 rounded bg-paper-2" aria-hidden>
                    <span className="absolute inset-y-0 start-0 rounded bg-accent-soft" style={{ width: `${(c.newUsers / maxUsers) * 100}%` }} />
                    <span className="absolute inset-y-0 start-0 rounded bg-accent" style={{ width: `${(c.payingUsers / maxUsers) * 100}%` }} />
                  </span>
                  <span className="tabular-nums text-ink-2">{t("{users} new · {paying} paid", { users: num(c.newUsers), paying: num(c.payingUsers) })}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card overflow-x-auto p-0">
            <h2 className="h2 px-5 pt-5">{t("CAC and LTV")}</h2>
            <p className="px-5 text-sm text-ink-3">{t("Each currency has its own row. Nothing is converted.")}</p>
            <table className="table mt-3" data-testid="channel-economics">
              <thead>
                <tr>
                  <th>{t("Channel")}</th><th className="text-end">{t("New users")}</th><th className="text-end">{t("Paying users")}</th>
                  <th className="text-end">{t("Spend")}</th><th className="text-end">CAC</th><th className="text-end">{t("Revenue")}</th>
                  <th className="text-end">LTV</th><th className="text-end">LTV:CAC</th>
                </tr>
              </thead>
              <tbody>
                {r.channels.flatMap((c) => {
                  const lines: (ChannelAmount | null)[] = c.amounts.length ? c.amounts : [null];
                  return lines.map((x, i) => (
                    <tr key={`${c.channel}:${x?.currency ?? ""}`}>
                      <td>
                        {i === 0 && (c.channel === CHANNEL_ORGANIC ? <span className="pill border-line">{label(c.channel)}</span> : label(c.channel))}
                        {i === 0 && c.currencyMismatch && <span className="block text-xs text-warn">{t("Spend and revenue are in different currencies.")}</span>}
                      </td>
                      <td className="text-end tabular-nums">{i === 0 ? num(c.newUsers) : ""}</td>
                      <td className="text-end tabular-nums">{i === 0 ? num(c.payingUsers) : ""}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.spend, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.cac, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.revenue, x.currency) : "0"}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.ltv, x.currency) : c.newUsers ? "0" : DASH}</td>
                      <td className="text-end tabular-nums">{x?.ltvToCac != null ? `${x.ltvToCac.toFixed(2)}×` : DASH}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
            <ul className="space-y-1 px-5 pb-5 pt-3 text-sm text-ink-3">
              <li>{t("New users: people whose first install is in this range, by that install's source.")}</li>
              <li>{rich(t("CAC: spend for the channel divided by its new users. Spend comes from the {spend} page."), { spend: spendLink })}</li>
              <li>{t("Revenue: what those new users paid in this range, minus refunds.")}</li>
              <li>{t("LTV: that revenue divided by new users. It is revenue seen so far, not a forecast.")}</li>
              <li>{t("LTV:CAC: LTV divided by CAC. It is shown only when spend and revenue are in the same currency.")}</li>
              <li>{anyMismatch ? t("— means no spend, no new users, or spend and revenue in different currencies.") : t("— means no spend or no new users.")}</li>
            </ul>
          </section>
        </>
      )}
      <ReportFreshness info={reports.info} path={`${base}/channels`} sp={sp} />
    </div>
  );
}
