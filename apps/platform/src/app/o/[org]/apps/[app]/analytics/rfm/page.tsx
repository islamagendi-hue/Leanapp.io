import Link from "next/link";
import { saveSegmentAudienceAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { AutoApply } from "@/components/AutoApply";
import { ReportFreshness } from "@/components/ReportFreshness";
import { RetentionTabs } from "@/components/RetentionTabs";
import { Stat } from "@/components/Stat";
import { getT } from "@/i18n/server";
import { NO_CURRENCY } from "@/modules/analytics/revenue-sql";
import { rfmReport, SEGMENT_LIST } from "@/modules/analytics/rfm";
import { RFM_WINDOWS, rfmWindow, segmentOf, SEGMENT_HINTS, SEGMENT_LABELS, type Score } from "@/modules/analytics/rfm-pure";
import { can } from "@/modules/rbac/authorize";
import { reportRunner } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("RFM segments") };
}

const num = (n: number) => n.toLocaleString("en-US");
const money = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (x: number | null) => (x === null ? "–" : `${(x * 100).toFixed(1)}%`);
const SCORES: Score[] = [1, 2, 3, 4, 5];

/** A cell of the R × FM map: the accent, stronger with the customers in it (the same heat scale as Retention curves). */
function heat(n: number, max: number) {
  if (!n) return { className: "text-ink-3", style: undefined };
  const share = n / max;
  return { className: share >= 0.7 ? "text-paper" : "text-ink", style: { background: `color-mix(in oklab, var(--color-accent) ${Math.round(10 + share * 85)}%, transparent)` } };
}

export default async function RfmPage(props: PageProps<"/o/[org]/apps/[app]/analytics/rfm">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "analytics.read");
  const t = await getT();
  const env = await pickEnvironment(environments, sp.env);
  const scope = { environmentId: env.id, timezone: a.timezone };
  const input = { window: rfmWindow(sp.window), currency: param(sp.currency) ?? null };
  const reports = reportRunner(ctx, scope, sp);
  const r = await reports.run("rfm", input, () => rfmReport(ctx, scope, input));
  const base = `/o/${org}/apps/${app}/analytics`;
  const canSave = can(ctx.role, "audiences.manage");
  const profiles = can(ctx.role, "users.read");
  const profileHref = (person: string) =>
    `${base}/users/profile?${new URLSearchParams({ env: env.type, ...(person.startsWith("anon:") ? { anon: person.slice(5) } : { user: person }) })}`;
  const cur = (c: string) => (c === NO_CURRENCY ? t("No currency") : c);
  const currency = r.currency ?? "";
  const maxCell = Math.max(1, ...r.cells.flat());
  const shown = r.segments.filter((s) => s.customers > 0);

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("RFM segments")} description={t("Customers grouped by how recently they bought, how often, and how much they spent, from Champions to Lost.")} env={env.type} />
      <RetentionTabs base={base} current="/rfm" env={env.type} />
      <form method="get" className="filters">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <label className="wide"><span className="label">{t("Purchases from")}</span>
          <select name="window" className="input" defaultValue={String(r.window)}>
            {RFM_WINDOWS.map((d) => <option key={d} value={d}>{t("Last {n} days", { n: d })}</option>)}
          </select>
        </label>
        {r.currencies.length > 1 && (
          <label><span className="label">{t("Currency")}</span>
            <select name="currency" className="input" defaultValue={currency}>
              {r.currencies.map((c) => <option key={c.currency} value={c.currency}>{cur(c.currency)} ({num(c.customers)})</option>)}
            </select>
          </label>
        )}
        <button className="btn" type="submit" data-apply>{t("Show")}</button>
        <ReportFreshness info={reports.info} path={`${base}/rfm`} sp={sp} className="filters-end" />
      </form>

      {!r.currency ? (
        <div className="card space-y-2">
          <p>{t("No purchases in the last {n} days.", { n: r.window })}</p>
          <p className="max-w-2xl text-sm text-ink-3">{t("RFM uses the same purchases as the Revenue report: events with a revenue amount, minus refunds.")}</p>
        </div>
      ) : (
        <>
          <section className="stat-grid" aria-label={t("RFM numbers")}>
            <Stat label={t("Customers")} value={num(r.customers)} note={t("At least one purchase in {currency}", { currency: cur(currency) })} />
            <Stat label={t("Net revenue")} value={money(r.revenue)} unit={cur(currency)} note={t("Purchases minus refunds")} />
            <Stat label={t("Revenue per customer")} value={r.customers ? money(r.revenue / r.customers) : "–"} unit={cur(currency)} />
            <Stat label={t("Segments with customers")} value={`${shown.length} / ${r.segments.length}`} />
          </section>
          {r.customers < 5 && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("With fewer than 5 customers, scores are relative to very few people, so the segments are rough.")}</p>}
          {r.currencies.length > 1 && <p className="text-sm text-ink-3">{t("Customers who paid in other currencies are scored on their own; nothing is converted.")}</p>}

          <section className="card space-y-3">
            <h2 className="h2">{t("Segment map")}</h2>
            <p className="text-sm text-ink-3">{t("Customers by recency score (rows) and frequency-and-monetary score (columns). 5 is best. Each cell belongs to one segment.")}</p>
            <div className="table-scroll">
              <table className="table text-sm" data-testid="rfm-grid">
                <thead><tr><th>{t("Recency")}</th>{SCORES.map((fm) => <th key={fm} className="text-center">{t("F+M {n}", { n: fm })}</th>)}</tr></thead>
                <tbody>
                  {[...SCORES].reverse().map((rs) => (
                    <tr key={rs}>
                      <th className="whitespace-nowrap text-start font-medium">{t("R {n}", { n: rs })}</th>
                      {SCORES.map((fm) => {
                        const n = r.cells[rs - 1][fm - 1];
                        const h = heat(n, maxCell);
                        return (
                          <td key={fm} className={`min-w-28 text-center ${h.className}`} style={h.style} title={t("{n} customers", { n: num(n) })}>
                            <span className="block text-xs">{t(SEGMENT_LABELS[segmentOf(rs, fm)])}</span>
                            <span className="block font-semibold tabular-nums">{num(n)}</span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-label={t("Segments")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="rfm-segments">
            {r.segments.map((s) => (
              <article key={s.segment} className={`card space-y-2 ${s.customers ? "" : "opacity-60"}`} data-segment={s.segment}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="font-semibold">{t(SEGMENT_LABELS[s.segment])}</h3>
                  <span className="text-xl font-bold tabular-nums">{num(s.customers)}</span>
                </div>
                <p className="text-sm text-ink-2">{t(SEGMENT_HINTS[s.segment])}</p>
                <dl className="space-y-1 text-xs text-ink-2">
                  <div>
                    <div className="flex justify-between"><dt>{t("Customers")}</dt><dd className="tabular-nums">{pct(s.customerShare)}</dd></div>
                    <div className="h-1.5 rounded-full bg-paper-2"><div className="h-1.5 rounded-full bg-[var(--color-chart-1)]" style={{ width: `${Math.round(s.customerShare * 100)}%` }} /></div>
                  </div>
                  <div>
                    <div className="flex justify-between"><dt>{t("Revenue")}</dt><dd className="tabular-nums">{pct(s.revenueShare)} · {money(s.revenue)} {cur(currency)}</dd></div>
                    <div className="h-1.5 rounded-full bg-paper-2"><div className="h-1.5 rounded-full bg-[var(--color-chart-3)]" style={{ width: `${Math.max(0, Math.min(100, Math.round((s.revenueShare ?? 0) * 100)))}%` }} /></div>
                  </div>
                </dl>
                {canSave && (
                  <ActionForm action={saveSegmentAudienceAction.bind(null, org, app, env.id, { kind: "rfm", segment: s.segment, window: r.window, currency })}
                    submitLabel={t("Save as audience")} className="space-y-2" buttonClass="btn-secondary min-h-9 text-sm" />
                )}
              </article>
            ))}
          </section>

          {/* A table per segment, folded except the first, so the page stays short. */}
          {shown.map((s, i) => (
            <details key={s.segment} open={i === 0} className="card-table" data-testid={`rfm-table-${s.segment}`}>
              <summary className="card-header cursor-pointer px-5 py-4">
                <h2 className="card-title">{t(SEGMENT_LABELS[s.segment])} <span className="font-normal text-ink-3">· {num(s.customers)}</span></h2>
                <p className="text-sm text-ink-3">
                  {t("Averages: {r} days since the last purchase, {f} purchases, {m} {currency}.", { r: s.avgRecency ?? "–", f: s.avgFrequency ?? "–", m: s.avgMonetary === null ? "–" : money(s.avgMonetary), currency: cur(currency) })}
                  {s.customers > SEGMENT_LIST && <> {t("The {n} with the most revenue are listed.", { n: SEGMENT_LIST })}</>}
                </p>
              </summary>
              <div className="table-scroll">
                <table className="table text-sm">
                  <thead><tr><th>{t("Person")}</th><th className="text-end">{t("Days since last purchase")}</th><th className="text-end">{t("Purchases")}</th><th className="text-end">{t("Net revenue")}</th><th className="text-center">R · F · M</th></tr></thead>
                  <tbody>
                    {r.people[s.segment].map((c) => (
                      <tr key={c.person}>
                        <td className="max-w-56 truncate font-mono text-xs" dir="ltr">{profiles ? <Link className="underline" href={profileHref(c.person)}>{c.person}</Link> : c.person}</td>
                        <td className="text-end tabular-nums">{num(c.recency)}</td>
                        <td className="text-end tabular-nums">{num(c.frequency)}</td>
                        <td className="text-end tabular-nums">{money(c.monetary)} {cur(currency)}</td>
                        <td className="text-center tabular-nums" dir="ltr">{c.r} · {c.f} · {c.m}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          <ul className="space-y-1 text-xs text-ink-3">
            <li>{t("Recency: days since the customer's last purchase. Frequency: purchases. Monetary: net revenue, purchases minus refunds. All in the window and the currency shown.")}</li>
            <li>{t("Each is scored 1 to 5 by quintile among these customers, 5 best. Customers with the same value share the lower score.")}</li>
            <li>{t("The segment comes from the recency score and the average of the frequency and monetary scores, rounded up.")}</li>
            <li>{t("A saved audience scores customers again each time it is computed, so it keeps matching this page.")}</li>
          </ul>
        </>
      )}
    </div>
  );
}
