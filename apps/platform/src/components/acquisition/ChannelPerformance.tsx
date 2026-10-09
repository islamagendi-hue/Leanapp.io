import type { ReactNode } from "react";
import { getT } from "@/i18n/server";
import { msg, type T } from "@/i18n/translate";
import { localDate } from "@/modules/analytics/range";
import type { ChannelPerformance as Row, ChannelReport, Money } from "@/modules/channels/report-pure";
import { GROUP_LABELS } from "@/modules/channels/registry";
import { num, pct } from "./AcquisitionHeader";

/**
 * Channel performance tables for the Acquisition pages (data from
 * modules/channels/report.ts). Every number says what it rests on: the
 * evidence line under installs, "not measured" where LeanApp has no data,
 * and the coverage and freshness card.
 */

const DASH = "—";
const money = (list: Money[]) => (list.length ? list.map((m) => `${m.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${m.currency}`).join(" · ") : DASH);

const GROUP_TONE: Record<string, string> = {
  paid: "border-accent/40",
  organic: "border-signal/40",
  owned: "border-line-strong",
  referral: "border-line-strong",
  custom: "border-line-strong",
  none: "border-warn/40 text-warn",
};

function ChannelCell({ c, t }: { c: Row; t: T }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{t(c.label)}</span>
      <span className={`pill text-xs ${GROUP_TONE[c.group] ?? "border-line"}`}>{t(GROUP_LABELS[c.group])}</span>
    </span>
  );
}

function evidenceLine(c: Pick<Row, "evidence">, t: T): string | null {
  const e = c.evidence;
  const parts = [
    e.deterministic && t("{n} deterministic", { n: num(e.deterministic) }),
    e.observed && t("{n} observed", { n: num(e.observed) }),
    e.modeled && t("{n} modeled", { n: num(e.modeled) }),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

const rate = (r: { eligible: number; retained: number } | undefined) => (r && r.eligible ? pct(r.retained, r.eligible) : DASH);

/** The full table (Sources & campaigns). */
export async function ChannelTable({ report, compact = false }: { report: ChannelReport; compact?: boolean }) {
  const t = await getT();
  const rows = compact ? report.channels.filter((c) => c.installs + c.reinstalls + c.conversions + c.clicks > 0).slice(0, 8) : report.channels;
  if (!rows.length) return <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No clicks, installs or conversions in this range.")}</p>;
  const measured = report.coverage.growthMeasured;
  return (
    <table className="table mt-3" data-testid={compact ? "channel-summary" : "channel-performance"}>
      <thead>
        <tr>
          <th className="min-w-44">{t("Channel")}</th>
          {!compact && <th className="text-end">{t("Clicks")}</th>}
          <th className="text-end">{t("Installs")}</th>
          {!compact && <th className="text-end">{t("New users")}</th>}
          {!compact && <th className="text-end">{t("Activated")}</th>}
          {!compact && <th className="text-end">{t("D7 retention")}</th>}
          {!compact && <th className="text-end">{t("Sign-ups")}</th>}
          <th className="text-end">{t("Purchases")}</th>
          <th className="text-end">{t("Revenue")}</th>
          {!compact && <th className="text-end">{t("Spend")}</th>}
          {!compact && <th className="text-end">CPI</th>}
          {!compact && <th className="text-end">CPA</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const ev = evidenceLine(c, t);
          return (
            <tr key={c.key} data-channel={c.key}>
              <td><ChannelCell c={c} t={t} /></td>
              {!compact && <td className="text-end tabular-nums">{num(c.clicks)}</td>}
              <td className="text-end tabular-nums">
                {num(c.installs + c.reinstalls)}
                {ev && <span className="block text-xs text-ink-3">{ev}</span>}
              </td>
              {!compact && <td className="text-end tabular-nums">{num(c.newUsers)}</td>}
              {!compact && <td className="text-end tabular-nums">{measured ? num(c.activated ?? 0) : DASH}</td>}
              {!compact && <td className="text-end tabular-nums">{measured ? rate(c.retention?.[1]) : DASH}</td>}
              {!compact && <td className="text-end tabular-nums">{num(c.signups)}</td>}
              <td className="text-end tabular-nums">{num(c.purchases)}</td>
              <td className="text-end tabular-nums">{money(c.revenue)}</td>
              {!compact && <td className="text-end tabular-nums">{money(c.spend)}</td>}
              {!compact && <td className="text-end tabular-nums">{money(c.cpi)}</td>}
              {!compact && <td className="text-end tabular-nums">{money(c.cpa)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const MODEL_NOTES: Record<string, string> = {
  last_touch: msg("Last touch: each conversion counts for the person's latest install or re-engagement before it, within the conversion window."),
  first_touch: msg("First touch: each conversion counts for the person's earliest install or re-engagement within the conversion window."),
};

/** What the table rests on: model, definitions and what isn't measured. */
export async function ChannelNotes({ report, spendLink }: { report: ChannelReport; spendLink: ReactNode }) {
  const t = await getT();
  return (
    <ul className="space-y-1 px-5 pb-5 pt-3 text-sm text-ink-3">
      <li>{t(MODEL_NOTES[report.model])}</li>
      <li>{t("Installs: deterministic = matched to a click your tracking link recorded; observed = the install's own campaign parameters, not verified; modeled = opt-in Android match on device signals.")}</li>
      <li>{t("Direct, unknown and unattributed are kept apart: direct means the parameters said direct, unknown means a source no rule recognises, unattributed means nothing was observed or matched. None of them is counted as organic.")}</li>
      <li>{report.coverage.growthMeasured
        ? t("Activated and D7 retention: new users in this range, from the growth model. Retention counts only people who have had 7 days.")
        : t("Activated and retention are not measured: turn on the growth model in Growth settings to measure them.")}</li>
      <li>{t("Sign-ups and purchases come from your conversion events; revenue is per currency, refunds subtracted, never converted.")}</li>
      <li>{t("CPI: spend ÷ installs. CPA: spend ÷ purchases. Both per spend currency, only where spend was entered.")} {spendLink}</li>
      <li>{t("Sessions by channel are not reported: no LeanApp SDK sends a session event that carries the touch.")}</li>
    </ul>
  );
}

/** Coverage, reconciliation and freshness card. */
export async function ChannelCoverage({ report, timezone }: { report: ChannelReport; timezone: string }) {
  const t = await getT();
  const c = report.coverage;
  const f = report.freshness;
  const when = (d: Date | null) => (d ? localDate(new Date(d), timezone) : t("never"));
  const items: [string, string, string][] = [
    [t("Installs with a touch"), `${num(c.attributed)} / ${num(c.installs)}`, c.installs ? pct(c.attributed, c.installs) : DASH],
    [t("Unattributed installs"), num(c.unattributed), c.iosUnattributed ? t("{n} on iOS, where paid installs can't be matched without a click id, SKAdNetwork or Apple Search Ads", { n: num(c.iosUnattributed) }) : ""],
    [t("Conversions with an install on record"), `${num(c.conversionsCredited)} / ${num(c.conversions)}`, c.conversions ? pct(c.conversionsCredited, c.conversions) : DASH],
    [t("Provider-reported (not added)"), num(c.providerReported), t("SKAdNetwork / AdAttributionKit postbacks: aggregate, shown on Attribution, never added to the installs above.")],
  ];
  return (
    <section className="card space-y-3" aria-label={t("Coverage and freshness")}>
      <h2 className="h2">{t("Coverage and freshness")}</h2>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        {items.map(([label, value, note]) => (
          <div key={label}><dt className="text-ink-3">{label}</dt><dd className="tabular-nums">{value}{note && <span className="block text-xs text-ink-3">{note}</span>}</dd></div>
        ))}
      </dl>
      {c.firstTouchFallback > 0 && (
        <p className="text-sm text-warn">{t("{n} conversions were processed before first-touch recording and use their last touch here.", { n: num(c.firstTouchFallback) })}</p>
      )}
      {report.spendIssues.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t("Spend reconciliation")}</p>
          <ul className="list-disc space-y-1 ps-5 text-ink-2">
            {report.spendIssues.slice(0, 10).map((i, n) => (
              <li key={n}>
                {i.rule === "S1"
                  ? t("{day}: {source} has spend per campaign and for the whole source; the whole-source {amount} {currency} is left out.", { day: i.day, source: i.source, amount: num(i.excluded), currency: i.currency })
                  : t("{day}: {sources} entered the same {currency} amount for one channel; counted once ({amount} {currency} left out).", { day: i.day, sources: i.sources.join(", "), amount: num(i.excluded), currency: i.currency })}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-ink-3">
        {t("Last click {click} · last install or open matched {attribution} · last conversion {conversion} · spend entered up to {spend}.", {
          click: when(f.lastClickAt), attribution: when(f.lastAttributionAt), conversion: when(f.lastConversionAt), spend: f.lastSpendDay ?? t("never"),
        })}
      </p>
    </section>
  );
}
