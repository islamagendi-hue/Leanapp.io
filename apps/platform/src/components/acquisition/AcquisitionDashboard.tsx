import type { ReactNode } from "react";
import Link from "next/link";
import { Stat } from "@/components/Stat";
import { getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";
import {
  GAP_LABELS, METRIC_IDS, PROVENANCE, PROVENANCE_HELP, PROVENANCE_LABELS,
  type AcquisitionDashboard, type CoverageWarning, type DashboardMetrics, type DashboardRow, type Metric, type MetricId, type Provenance, type Ratio,
} from "@/modules/channels/provenance";
import type { Money } from "@/modules/channels/report-pure";
import { GROUP_LABELS } from "@/modules/channels/registry";
import { num, pct } from "./AcquisitionHeader";

/**
 * The Acquisition dashboard (data from modules/channels/provenance-data.ts):
 * key numbers, coverage warnings, and every metric by source and campaign,
 * each labelled observed / imported / modeled / unavailable. Tables on wide
 * screens; one expandable card per row on phones.
 */

const DASH = "—";

export const METRIC_LABELS: Record<MetricId, string> = {
  users: msg("New users"),
  installs: msg("Installs"),
  signups: msg("Sign-ups"),
  activated: msg("Activated"),
  purchases: msg("Purchases"),
  revenue: msg("Revenue"),
  spend: msg("Spend"),
  cac: msg("CAC"),
  roas: msg("ROAS"),
};

/** What each column normally rests on; a cell is tagged only where it differs. */
const COLUMN_PROVENANCE: Record<MetricId, Provenance> = {
  users: "observed", installs: "observed", signups: "observed", activated: "observed", purchases: "observed", revenue: "observed",
  spend: "imported", cac: "imported", roas: "imported",
};

const TONE: Record<Provenance, string> = {
  observed: "border-signal/40",
  imported: "border-accent/40 text-accent-ink",
  modeled: "border-line-strong text-ink-2",
  unavailable: "border-warn/40 text-warn",
};

export function ProvenanceTag({ p, t }: { p: Provenance; t: T }) {
  return <span className={`pill text-[10px] ${TONE[p]}`} data-provenance={p}>{t(PROVENANCE_LABELS[p])}</span>;
}

const moneyText = (list: Money[]) => list.map((m) => `${m.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${m.currency}`).join(" · ");
const ratioText = (list: Ratio[]) => list.map((r) => `${r.value.toFixed(2)}× ${r.currency}`).join(" · ");

function valueText(id: MetricId, m: DashboardMetrics): string {
  switch (id) {
    case "revenue": return m.revenue.value === null ? DASH : m.revenue.value.length ? moneyText(m.revenue.value) : "0";
    case "spend": return m.spend.value === null ? DASH : moneyText(m.spend.value);
    case "cac": return m.cac.value === null ? DASH : moneyText(m.cac.value);
    case "roas": return m.roas.value === null ? DASH : ratioText(m.roas.value);
    case "activated": return m.activated.value === null ? DASH : num(m.activated.value);
    default: return num(m[id].value);
  }
}

function detailText(id: MetricId, m: DashboardMetrics, t: T): string | null {
  if (id === "installs" && m.installs.modeled > 0 && m.installs.provenance !== "modeled") return t("{n} modeled", { n: num(m.installs.modeled) });
  if (id === "spend" && m.spend.origins.length) {
    return m.spend.origins.map((o) => (o === "import" ? t("from an ad account") : t("entered by hand"))).join(" · ");
  }
  return null;
}

const reasonsText = (metric: Metric<unknown>, t: T) => metric.reasons.map((r) => t(GAP_LABELS[r])).join(" · ");

/** One table cell or card value: the number, a tag where its label differs from the column's, and what is missing. */
function MetricCell({ id, m, t, full = false }: { id: MetricId; m: DashboardMetrics; t: T; full?: boolean }) {
  const metric = m[id] as Metric<unknown>;
  const detail = detailText(id, m, t);
  const showTag = full || metric.provenance !== COLUMN_PROVENANCE[id];
  return (
    <>
      <span className="tabular-nums" dir="ltr">{valueText(id, m)}</span>
      {showTag && <span className="mt-0.5 block"><ProvenanceTag p={metric.provenance} t={t} /></span>}
      {detail && <span className="block text-xs text-ink-3">{detail}</span>}
      {metric.provenance !== "unavailable" && !metric.complete && (
        <span className="block text-xs text-warn" title={reasonsText(metric, t)} data-incomplete>{t("Incomplete")}{full && `: ${reasonsText(metric, t)}`}</span>
      )}
      {metric.provenance === "unavailable" && metric.reasons.length > 0 && (full || (id !== "activated" && metric.reasons.join() !== "not_paid")) && (
        <span className="block text-xs text-ink-3">{reasonsText(metric, t)}</span>
      )}
    </>
  );
}

/** The key numbers: one tile per metric, each with its label and what is missing. */
export async function DashboardTotals({ dashboard }: { dashboard: AcquisitionDashboard }) {
  const t = await getT();
  const m = dashboard.totals;
  return (
    <section className="stat-grid" aria-label={t("Acquisition numbers")}>
      {METRIC_IDS.map((id) => {
        const metric = m[id] as Metric<unknown>;
        const detail = detailText(id, m, t);
        const value = valueText(id, m);
        return (
          <Stat key={id} label={t(METRIC_LABELS[id])} value={value} small={value.length > 12}
            note={
              <span className="flex flex-wrap items-center gap-1">
                <ProvenanceTag p={metric.provenance} t={t} />
                {metric.provenance !== "unavailable" && !metric.complete && <span className="text-warn" data-incomplete>{t("Incomplete")}</span>}
                {metric.reasons.length > 0 && <span className="w-full">{reasonsText(metric, t)}</span>}
                {detail && <span className="w-full">{detail}</span>}
              </span>
            } />
        );
      })}
    </section>
  );
}

const ACTION_LABELS: Record<NonNullable<CoverageWarning["action"]>, string> = {
  spend: msg("Ad spend"),
  integrations: msg("Integrations"),
  growth: msg("Growth settings"),
  attribution: msg("Attribution"),
};

/** Coverage warnings: what is missing, and where to fix it. */
export async function CoverageWarnings({ dashboard, hrefs }: { dashboard: AcquisitionDashboard; hrefs: Partial<Record<NonNullable<CoverageWarning["action"]>, string>> }) {
  const t = await getT();
  const c = dashboard.coverage;
  const items: [string, string, string][] = [
    [t("Installs with a touch"), `${num(c.attributedInstalls)} / ${num(c.installs)}`, c.installs ? pct(c.attributedInstalls, c.installs) : DASH],
    [t("Conversions with an install on record"), `${num(c.creditedConversions)} / ${num(c.conversions)}`, c.conversions ? pct(c.creditedConversions, c.conversions) : DASH],
    [t("Paid channels with spend"), `${num(c.paidChannelsWithSpend)} / ${num(c.paidChannels)}`, c.paidChannels ? pct(c.paidChannelsWithSpend, c.paidChannels) : DASH],
  ];
  return (
    <section className="card space-y-3" aria-label={t("Data coverage")} data-testid="coverage-warnings">
      <h2 className="h2">{t("Data coverage")}</h2>
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        {items.map(([label, value, share]) => (
          <div key={label}><dt className="text-ink-3">{label}</dt><dd className="tabular-nums">{value} <span className="text-ink-3">· {share}</span></dd></div>
        ))}
      </dl>
      {dashboard.warnings.length === 0 ? (
        <p className="text-sm text-ink-3">{t("Nothing missing: spend covers every paid channel and every install and conversion has a source.")}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {dashboard.warnings.map((w) => {
            const href = w.action ? hrefs[w.action] : undefined;
            return (
              <li key={`${w.id}:${JSON.stringify(w.params)}`} data-warning={w.id}
                className={`rounded-lg px-3 py-2 ${w.severity === "warn" ? "bg-warn-soft text-warn" : "border border-line text-ink-2"}`}>
                {t(w.text, w.labels ? { ...w.params, channels: w.labels.map((l) => t(l)).join(" · ") } : w.params)}
                {href && w.action && <> <Link className="whitespace-nowrap underline" href={href}>{t(ACTION_LABELS[w.action])}</Link></>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What the four labels mean. */
export async function ProvenanceLegend() {
  const t = await getT();
  return (
    <details className="rounded-lg border border-line px-3 py-2 text-sm text-ink-2">
      <summary className="cursor-pointer font-medium">{t("What observed, imported, modeled and unavailable mean")}</summary>
      <ul className="mt-2 space-y-2">
        {PROVENANCE.map((p) => <li key={p} className="flex flex-wrap items-baseline gap-2"><ProvenanceTag p={p} t={t} /><span>{t(PROVENANCE_HELP[p])}</span></li>)}
        <li>{t("CAC is spend ÷ new users and ROAS is revenue ÷ spend, per currency, never converted. They take the weakest label of what they rest on, and say Incomplete when spend or conversions are partial.")}</li>
        <li>{t("Totals are blended across every channel, organic included.")}</li>
      </ul>
    </details>
  );
}

function RowName({ r, t, kind }: { r: DashboardRow; t: T; kind: "channel" | "campaign" }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {kind === "campaign" ? (
        <>
          <span className="font-medium" dir="auto">{r.wholeSource ? t("All campaigns (spend not split)") : r.campaign ?? t("(no campaign)")}</span>
          <span className="text-xs text-ink-3">{t(r.label)}</span>
        </>
      ) : (
        <>
          <span className="font-medium">{t(r.label)}</span>
          <span className="pill text-xs border-line">{t(GROUP_LABELS[r.group])}</span>
        </>
      )}
    </span>
  );
}

/** Every metric by source (channel) or by campaign. */
export async function DashboardTable({ rows, kind, empty }: { rows: DashboardRow[]; kind: "channel" | "campaign"; empty: ReactNode }) {
  const t = await getT();
  if (!rows.length) return <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{empty}</p>;
  const testId = kind === "channel" ? "dashboard-by-source" : "dashboard-by-campaign";
  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
        <table className="table mt-3" data-testid={testId}>
          <thead>
            <tr>
              <th className="min-w-44">{kind === "channel" ? t("Source") : t("Campaign")}</th>
              {METRIC_IDS.map((id) => (
                <th key={id} className="text-end">
                  {t(METRIC_LABELS[id])}
                  <span className="mt-0.5 block font-sans normal-case tracking-normal"><ProvenanceTag p={COLUMN_PROVENANCE[id]} t={t} /></span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-row={r.key}>
                <td><RowName r={r} t={t} kind={kind} /></td>
                {METRIC_IDS.map((id) => <td key={id} className="text-end"><MetricCell id={id} m={r.metrics} t={t} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line border-t border-line sm:hidden" data-testid={`${testId}-cards`}>
        {rows.map((r) => (
          <li key={r.key} data-row={r.key}>
            <details className="group px-5 py-3">
              <summary className="cursor-pointer">
                <RowName r={r} t={t} kind={kind} />
                <span className="mt-1 block text-xs text-ink-3 tabular-nums">
                  {t("{users} new users · {installs} installs · revenue {revenue}", { users: num(r.metrics.users.value), installs: num(r.metrics.installs.value), revenue: valueText("revenue", r.metrics) })}
                </span>
              </summary>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                {METRIC_IDS.map((id) => (
                  <div key={id} className="min-w-0 break-words">
                    <dt className="text-ink-3">{t(METRIC_LABELS[id])}</dt>
                    <dd><MetricCell id={id} m={r.metrics} t={t} full /></dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}
