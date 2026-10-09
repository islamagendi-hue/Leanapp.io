import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num } from "@/components/acquisition/AcquisitionHeader";
import { envName, rich } from "@/components/acquisition/rich";
import { ReportFreshness } from "@/components/ReportFreshness";
import { Stat } from "@/components/Stat";
import { TrendChart } from "@/components/TrendChart";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { localDate } from "@/modules/analytics/range";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { channelEconomicsReport, TOP_BUYERS } from "@/modules/attribution/economics";
import { curveDays, LTV_WINDOWS, ltvWindow, type ChannelAmount } from "@/modules/attribution/economics-pure";
import { can } from "@/modules/rbac/authorize";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("CAC & LTV") };
}

const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source"), [CHANNEL_NO_INSTALL]: msg("No install on record") };
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
  const input = { days: range.days, from: range.from, to: range.to, window: ltvWindow(sp.window) };
  const reports = reportRunner(ctx, scope, sp);
  const r = await reports.run("channel_economics", input, () => channelEconomicsReport(ctx, scope, input));
  const base = `/o/${org}/apps/${app}/acquisition`;
  const t = await getT();
  const label = (c: string) => (CHANNEL_LABELS[c] ? t(CHANNEL_LABELS[c]) : c);
  const dayLabel = (d: number) => (d === 0 ? t("First day") : t("Day {n}", { n: d }));
  const spendTotals = new Map<string, number>();
  for (const c of r.channels) for (const x of c.amounts) if (x.spend !== null) spendTotals.set(x.currency, (spendTotals.get(x.currency) ?? 0) + x.spend);
  const anyMismatch = r.channels.some((c) => c.currencyMismatch);
  const maturing = r.totals.buyers - r.totals.buyersComplete;
  const spendLink = <Link className="underline" href={`${base}/spend?env=${env.type}`}>{t("Ad spend")}</Link>;
  const profiles = can(ctx.role, "users.read");
  const profileHref = (person: string) =>
    `/o/${org}/apps/${app}/analytics/users/profile?${new URLSearchParams({ env: env.type, ...(person.startsWith("anon:") ? { anon: person.slice(5) } : { user: person }) })}`;
  const days = curveDays(r.window);
  // One curve chart per currency: a line per channel, over the days every line has buyers for.
  const curveCurrencies = [...new Set(r.channels.flatMap((c) => c.curve.map((x) => x.currency)))].sort();
  const charts = curveCurrencies.map((currency) => {
    const lines = r.channels.flatMap((c) => c.curve.filter((x) => x.currency === currency).map((x) => ({ key: label(c.channel), points: x.points })));
    let upTo = 0;
    while (upTo < days.length && lines.every((l) => l.points[upTo]?.ltv !== null)) upTo++;
    return { currency, labels: days.slice(0, upTo).map(dayLabel), series: lines.map((l) => ({ key: l.key, counts: l.points.slice(0, upTo).map((p) => p.ltv ?? 0) })) };
  });

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/channels" env={env.type} title={t("CAC and LTV by channel")}
        description={t("What each channel cost and what its buyers paid after their first purchase. LTV is revenue seen so far, not a forecast.")} />
      <AcquisitionRange env={env.type} range={r.range}>
        <label><span className="label">{t("LTV window")}</span>
          <select name="window" className="input" defaultValue={String(r.window)}>
            {LTV_WINDOWS.map((d) => <option key={d} value={d}>{t("{n} days after first purchase", { n: d })}</option>)}
          </select>
        </label>
      </AcquisitionRange>

      <section className="stat-grid" aria-label={t("Channel numbers")}>
        <Stat label={t("New users")} value={num(r.totals.newUsers)} note={t("First install in this range")} />
        <Stat label={t("First-time buyers")} value={num(r.totals.buyers)} note={t("First purchase in this range")} />
        <Stat label={t("Full window")} value={`${num(r.totals.buyersComplete)} / ${num(r.totals.buyers)}`}
          note={maturing ? t("{n} still maturing", { n: num(maturing) }) : t("Every window has ended")} />
        <Stat label={t("Spend")} value={spendTotals.size ? [...spendTotals].map(([c, v]) => `${money(v)} ${c}`).join(" · ") : DASH} small={spendTotals.size > 1}
          note={spendTotals.size ? t("Entered on the Ad spend page") : t("No spend entered for this range")} />
      </section>

      {r.channels.length === 0 ? (
        <div className="card space-y-2">
          <p>{t("No new users, buyers or spend in {env} for the selected range of dates.", { env: envName(t, env.type) })}</p>
          <p className="max-w-2xl text-sm text-ink-3">{rich(t("New users come from installs your app reports. Buyers come from your revenue events. Enter costs on the {spend} page."), { spend: spendLink })}</p>
        </div>
      ) : (
        <>
          <section className="card overflow-x-auto p-0">
            <h2 className="h2 px-5 pt-5">{t("CAC and LTV")}</h2>
            <p className="px-5 text-sm text-ink-3">{t("Each currency has its own row. Nothing is converted.")}</p>
            <table className="table mt-3" data-testid="channel-economics">
              <thead>
                <tr>
                  <th>{t("Channel")}</th><th className="text-end">{t("New users")}</th><th className="text-end">{t("Spend")}</th><th className="text-end">CAC</th>
                  <th className="text-end">{t("Buyers")}</th><th className="text-end">{t("Full window")}</th>
                  <th className="text-end">{t("Revenue in window")}</th><th className="text-end">LTV</th><th className="text-end">LTV:CAC</th>
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
                      <td className="text-end tabular-nums">{x ? amount(x.spend, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.cac, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{i === 0 ? num(c.buyers) : ""}</td>
                      <td className="text-end tabular-nums">
                        {i === 0 && (c.buyers ? <>{num(c.buyersComplete)} / {num(c.buyers)}{c.buyersComplete < c.buyers && <span className="block text-xs text-warn">{t("still maturing")}</span>}</> : DASH)}
                      </td>
                      <td className="text-end tabular-nums">{x ? amount(x.revenue, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{x ? amount(x.ltv, x.currency) : DASH}</td>
                      <td className="text-end tabular-nums">{x?.ltvToCac != null ? `${x.ltvToCac.toFixed(2)}×` : DASH}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
            <ul className="space-y-1 px-5 pb-5 pt-3 text-sm text-ink-3">
              <li>{t("New users: people whose first install is in this range, by that install's source.")}</li>
              <li>{rich(t("CAC: spend for the channel divided by its new users. Spend comes from the {spend} page."), { spend: spendLink })}</li>
              <li>{t("Buyers: people whose first purchase ever is in this range. Their channel is the source of their first install.")}</li>
              <li>{t("Revenue in window: what each buyer paid in the {n} days from their first purchase, minus refunds.", { n: r.window })}</li>
              <li>{t("LTV: that revenue divided by buyers. It is revenue seen so far, not a forecast.")}</li>
              <li>{t("Still maturing: some buyers have not had the full window yet, so LTV can still grow.")}</li>
              <li>{t("LTV:CAC: LTV divided by CAC, only when both are in the same currency. The two use different groups: installs in the range, and first purchases in the range.")}</li>
              <li>{anyMismatch ? t("— means no spend, no new users, or spend and revenue in different currencies.") : t("— means no spend, no new users or no buyers.")}</li>
            </ul>
          </section>

          {charts.length > 0 && (
            <section className="card space-y-3">
              <h2 className="h2">{t("LTV over time")}</h2>
              <p className="text-sm text-ink-3">{t("Revenue per buyer, adding up from the first purchase. Each point only counts buyers who have had that many days.")}</p>
              {charts.map((ch) => (
                <div key={ch.currency} className="space-y-2">
                  {charts.length > 1 && <h3 className="font-medium">{ch.currency}</h3>}
                  {ch.labels.length > 1
                    ? <TrendChart days={ch.labels} series={ch.series} label={t("LTV per buyer in {currency}, by days since first purchase", { currency: ch.currency })} />
                    : <p className="text-sm text-ink-2">{t("Not enough time has passed to draw a curve.")}</p>}
                </div>
              ))}
              <div className="overflow-x-auto">
                <table className="table text-sm" data-testid="ltv-curve">
                  <thead><tr><th>{t("Channel")}</th>{days.map((d) => <th key={d} className="text-end">{dayLabel(d)}</th>)}</tr></thead>
                  <tbody>
                    {r.channels.flatMap((c) => c.curve.map((x) => (
                      <tr key={`${c.channel}:${x.currency}`}>
                        <td>{label(c.channel)} <span className="text-ink-3">{x.currency}</span></td>
                        {x.points.map((pt) => (
                          <td key={pt.day} className="text-end tabular-nums">
                            {pt.ltv === null ? DASH : money(pt.ltv)}
                            <span className={`block text-xs ${pt.people < c.buyers ? "text-warn" : "text-ink-3"}`}>{t("{n} of {total} buyers", { n: num(pt.people), total: num(c.buyers) })}</span>
                          </td>
                        ))}
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {r.people.length > 0 && (
            <section className="card overflow-x-auto p-0">
              <h2 className="h2 px-5 pt-5">{t("Buyers with the most revenue")}</h2>
              <p className="px-5 text-sm text-ink-3">{t("Up to {n} people from this cohort. A person who paid in two currencies has two rows.", { n: TOP_BUYERS })}</p>
              <table className="table mt-3" data-testid="cohort-people">
                <thead>
                  <tr><th>{t("Person")}</th><th>{t("Channel")}</th><th>{t("First purchase")}</th><th className="text-end">{t("Purchases")}</th><th className="text-end">{t("Revenue in window")}</th></tr>
                </thead>
                <tbody>
                  {r.people.map((p) => (
                    <tr key={`${p.person}:${p.currency}`}>
                      <td className="max-w-56 truncate font-mono text-xs" dir="ltr">
                        {profiles ? <Link className="underline" href={profileHref(p.person)}>{p.person}</Link> : p.person}
                      </td>
                      <td>{label(p.channel)}</td>
                      <td className="tabular-nums" dir="ltr">{localDate(new Date(p.firstPurchaseAt), a.timezone)}</td>
                      <td className="text-end tabular-nums">{num(p.purchases)}</td>
                      <td className="text-end tabular-nums">
                        {money(p.revenue)} {p.currency}
                        {!p.complete && <span className="block text-xs text-warn">{t("still maturing")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
      <ReportFreshness info={reports.info} path={`${base}/channels`} sp={sp} />
    </div>
  );
}
