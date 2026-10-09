import Link from "next/link";
import { saveSegmentAudienceAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader } from "@/components/AnalyticsHeader";
import { AutoApply } from "@/components/AutoApply";
import { ReportFreshness } from "@/components/ReportFreshness";
import { RetentionTabs } from "@/components/RetentionTabs";
import { Stat } from "@/components/Stat";
import { TrendChart } from "@/components/TrendChart";
import { getLang, getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { AT_RISK_LIST, churnReport } from "@/modules/analytics/churn";
import { BUCKET_LABELS, CHURN_WINDOWS, churnInterval, churnWindow, type ChurnBucket } from "@/modules/analytics/churn-pure";
import { localDate, shortDay } from "@/modules/analytics/range";
import { CHANNEL_NO_INSTALL, CHANNEL_ORGANIC, CHANNEL_UNKNOWN } from "@/modules/analytics/sql";
import { can } from "@/modules/rbac/authorize";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Churn") };
}

const CHANNEL_LABELS: Record<string, string> = { [CHANNEL_ORGANIC]: msg("organic"), [CHANNEL_UNKNOWN]: msg("Unknown source"), [CHANNEL_NO_INSTALL]: msg("No install on record") };
const num = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);

export default async function ChurnPage(props: PageProps<"/o/[org]/apps/[app]/analytics/churn">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const env = await pickEnvironment(environments, sp.env);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const input = { window: churnWindow(sp.window), interval: churnInterval(sp.interval) };
  const reports = reportRunner(ctx, scope, sp);
  const r = await reports.run("churn", input, () => churnReport(ctx, scope, input));
  const base = `/o/${org}/apps/${app}/analytics`;
  const label = (c: string) => (CHANNEL_LABELS[c] ? t(CHANNEL_LABELS[c]) : c);
  const canSave = can(ctx.role, "audiences.manage");
  const profiles = can(ctx.role, "users.read");
  const profileHref = (person: string) =>
    `${base}/users/profile?${new URLSearchParams({ env: env.type, ...(person.startsWith("anon:") ? { anon: person.slice(5) } : { user: person }) })}`;
  const rules: Record<ChurnBucket, string> = {
    churned: t("Last seen more than {n} days ago.", { n: r.window }),
    at_risk: t("Last seen {from} to {n} days ago.", { from: r.atRiskAfter, n: r.window }),
    active: t("Seen in the last {n} days.", { n: r.atRiskAfter }),
  };
  const counted = r.series.filter((p) => p.rate !== null);

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Churn")} description={t("Who stopped coming back: people with no activity for a whole churn window, and those on their way there.")} env={env.type} />
      <RetentionTabs base={base} current="/churn" env={env.type} />
      <form method="get" className="filters">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <label className="wide"><span className="label">{t("Churn window")}</span>
          <select name="window" className="input" defaultValue={String(r.window)}>
            {CHURN_WINDOWS.map((d) => <option key={d} value={d}>{t("{n} days without activity", { n: d })}</option>)}
          </select>
        </label>
        <label><span className="label">{t("Churn rate by")}</span>
          <select name="interval" className="input" defaultValue={r.interval}>
            <option value="week">{t("Week")}</option>
            <option value="month">{t("Month")}</option>
          </select>
        </label>
        <button className="btn" type="submit" data-apply>{t("Show")}</button>
        <ReportFreshness info={reports.info} path={`${base}/churn`} sp={sp} className="filters-end" />
      </form>

      {r.totals.people === 0 ? (
        <div className="card"><p>{t("No activity in this environment yet. Churn shows once people have used your app.")}</p></div>
      ) : (
        <>
          <section className="stat-grid" aria-label={t("Churn numbers")}>
            <Stat label={t("Churned")} value={num(r.totals.churned)} note={rules.churned} />
            <Stat label={t("At risk")} value={num(r.totals.at_risk)} note={rules.at_risk} />
            <Stat label={t("Active")} value={num(r.totals.active)} note={rules.active} />
            <Stat label={t("Churned share")} value={pct(r.totals.churned / r.totals.people)} note={t("Of {n} people with activity on record", { n: num(r.totals.people) })} />
          </section>

          <section className="card-table">
            <div className="card-header px-5 pt-5">
              <h2 className="card-title">{t("Groups")}</h2>
              <p className="text-sm text-ink-3">{canSave ? t("Save a group as an audience to reach it with a campaign or a flow. Its members update as people come and go.") : t("People with audience access can save these groups as audiences.")}</p>
            </div>
            <div className="table-scroll">
              <table className="table" data-testid="churn-buckets">
                <thead><tr><th>{t("Group")}</th><th className="text-end">{t("People")}</th><th className="text-end">{t("Share")}</th><th>{t("Rule")}</th>{canSave && <th />}</tr></thead>
                <tbody>
                  {(["churned", "at_risk", "active"] as const).map((b) => (
                    <tr key={b}>
                      <td className="font-medium">{t(BUCKET_LABELS[b])}</td>
                      <td className="text-end tabular-nums">{num(r.totals[b])}</td>
                      <td className="text-end tabular-nums">{pct(r.totals[b] / r.totals.people)}</td>
                      <td className="text-sm text-ink-2">{rules[b]}</td>
                      {canSave && (
                        <td className="text-end">
                          {b !== "active" && (
                            <ActionForm action={saveSegmentAudienceAction.bind(null, org, app, env.id, { kind: "churn", bucket: b, window: r.window })}
                              submitLabel={t("Save as audience")} className="inline-flex flex-col items-end gap-1" buttonClass="btn-secondary min-h-9 whitespace-nowrap text-sm" />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card space-y-3">
            <h2 className="h2">{t("Churn rate over time")}</h2>
            <p className="text-sm text-ink-3">
              {r.interval === "week"
                ? t("Of the people active at the start of each week (seen in the {n} days before it), the share not seen in the {n} days up to its end.", { n: r.window })
                : t("Of the people active at the start of each month (seen in the {n} days before it), the share not seen in the {n} days up to its end.", { n: r.window })}
            </p>
            {counted.length > 1
              ? <TrendChart days={counted.map((p) => p.start)} series={[{ key: t("Churn rate (%)"), counts: counted.map((p) => Math.round(p.rate! * 1000) / 10) }]} label={t("Churn rate (%) by period")} />
              : <p className="text-sm text-ink-2">{t("Not enough history yet to draw a curve.")}</p>}
            <div className="table-scroll">
              <table className="table text-sm" data-testid="churn-series">
                <thead><tr><th>{r.interval === "week" ? t("Week of") : t("Month of")}</th><th className="text-end">{t("Active at start")}</th><th className="text-end">{t("Churned by end")}</th><th className="text-end">{t("Churn rate")}</th></tr></thead>
                <tbody>
                  {[...r.series].reverse().map((p) => (
                    <tr key={p.start}>
                      <td className="whitespace-nowrap">{shortDay(p.start, lang)}{p.partial && <span className="ms-2 text-xs text-warn">{t("so far")}</span>}</td>
                      <td className="text-end tabular-nums">{num(p.base)}</td>
                      <td className="text-end tabular-nums">{num(p.churned)}</td>
                      <td className="text-end tabular-nums">{pct(p.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card-table">
            <div className="card-header px-5 pt-5">
              <h2 className="card-title">{t("Churn by acquisition channel")}</h2>
              <p className="text-sm text-ink-3">{t("A person's channel is the source of their first install, as in CAC & LTV.")}</p>
            </div>
            <div className="table-scroll">
              <table className="table" data-testid="churn-channels">
                <thead><tr><th>{t("Channel")}</th><th className="text-end">{t("People")}</th><th className="text-end">{t("Active")}</th><th className="text-end">{t("At risk")}</th><th className="text-end">{t("Churned")}</th><th className="text-end">{t("Churned share")}</th></tr></thead>
                <tbody>
                  {r.channels.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel === CHANNEL_ORGANIC ? <span className="pill border-line">{label(c.channel)}</span> : label(c.channel)}</td>
                      <td className="text-end tabular-nums">{num(c.people)}</td>
                      <td className="text-end tabular-nums">{num(c.active)}</td>
                      <td className="text-end tabular-nums">{num(c.atRisk)}</td>
                      <td className="text-end tabular-nums">{num(c.churned)}</td>
                      <td className="text-end tabular-nums">{pct(c.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card-table">
            <div className="card-header px-5 pt-5">
              <h2 className="card-title">{t("At risk now")}</h2>
              <p className="text-sm text-ink-3">{t("Closest to churning first, up to {n} people.", { n: AT_RISK_LIST })}</p>
            </div>
            {r.atRisk.length === 0 ? <p className="px-5 pb-5 text-sm text-ink-2">{t("Nobody is at risk right now.")}</p> : (
              <div className="table-scroll">
                <table className="table" data-testid="churn-at-risk">
                  <thead><tr><th>{t("Person")}</th><th>{t("Channel")}</th><th>{t("First seen")}</th><th>{t("Last seen")}</th><th className="text-end">{t("Days away")}</th></tr></thead>
                  <tbody>
                    {r.atRisk.map((p) => (
                      <tr key={p.person}>
                        <td className="max-w-56 truncate font-mono text-xs" dir="ltr">{profiles ? <Link className="underline" href={profileHref(p.person)}>{p.person}</Link> : p.person}</td>
                        <td>{label(p.channel)}</td>
                        <td className="tabular-nums" dir="ltr">{localDate(new Date(p.firstSeenAt), a.timezone)}</td>
                        <td className="tabular-nums" dir="ltr">{localDate(new Date(p.lastSeenAt), a.timezone)}</td>
                        <td className="text-end tabular-nums">{num(p.daysAway)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="text-xs text-ink-3">{t("Last seen is the time of the latest event your app sent for a person, of any kind. Calendar days are in {timezone}.", { timezone: a.timezone })}</p>
        </>
      )}
    </div>
  );
}
