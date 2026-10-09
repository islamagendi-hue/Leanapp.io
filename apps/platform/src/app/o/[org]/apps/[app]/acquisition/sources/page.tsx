import Link from "next/link";
import { AcquisitionHeader, AcquisitionRange, money, num } from "@/components/acquisition/AcquisitionHeader";
import { ChannelCoverage, ChannelNotes, ChannelTable } from "@/components/acquisition/ChannelPerformance";
import { rich } from "@/components/acquisition/rich";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { CHANNEL_KEY_LABELS } from "@/modules/analytics/sql";
import { mergeCampaignRows } from "@/modules/attribution/pure";
import { attributionOverview } from "@/modules/attribution/reports";
import { getT } from "@/i18n/server";
import { channelReport } from "@/modules/channels/report";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Sources & campaigns") };
}

export default async function SourcesPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/sources">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const rangeInput = rangeFromParams(toSearch(sp));
  const model = sp.model === "first_touch" || sp.model === "last_touch" ? sp.model : undefined;
  const [r, ch] = await Promise.all([
    attributionOverview(ctx, { environmentId: env.id, timezone: a.timezone }, rangeInput),
    channelReport(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone, includeSpend: can(ctx.role, "analytics.read") }, { ...rangeInput, model }),
  ]);
  const base = `/o/${org}/apps/${app}/acquisition`;
  const campaigns = mergeCampaignRows(r.byCampaign);
  const t = await getT();
  const spendLink = <Link className="underline" href={`${base}/spend?env=${env.type}`}>{t("Ad spend")}</Link>;

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/sources" env={env.type} title={t("Sources & campaigns")}
        description={t("Installs, new users, conversions, revenue and cost per channel, then per source and campaign as labelled on your tracking links or sent by ad networks in their click ids and UTM parameters.")} />
      <AcquisitionRange env={env.type} range={r.range}>
        <label><span className="label">{t("Credit")}</span>
          <select name="model" className="input" defaultValue={ch.model}>
            <option value="last_touch">{t("Last touch")}</option>
            <option value="first_touch">{t("First touch")}</option>
          </select>
        </label>
      </AcquisitionRange>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Channels")}</h2>
        <p className="px-5 text-sm text-ink-3">{t("Every click, install and conversion in this range on exactly one channel, from the channel registry and your custom channel rules.")}</p>
        <ChannelTable report={ch} />
        <ChannelNotes report={ch} spendLink={spendLink} />
      </section>
      <ChannelCoverage report={ch} timezone={a.timezone} />

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Installs by source and campaign")}</h2>
        <p className="px-5 text-sm text-ink-3">{t("Deterministic: matched to a click your tracking link recorded. Reported: only the install's own context (an ad-network click id or UTM parameters) names the source; nothing verifies it. Probabilistic: opt-in Android match on device signals. Installs with nothing to match are unattributed, including iOS installs without a LeanApp click id.")}</p>
        {r.bySource.length === 0 ? <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No installs in this range.")}</p> : (
          <table className="table mt-3">
            <thead><tr><th>{t("Source")}</th><th>{t("Campaign")}</th><th className="text-end">{t("Installs")}</th><th className="text-end">{t("Deterministic")}</th><th className="text-end">{t("Reported")}</th><th className="text-end">{t("Probabilistic")}</th><th className="text-end">{t("Re-engagements")}</th></tr></thead>
            <tbody>
              {r.bySource.map((s) => (
                <tr key={`${s.source}:${s.campaign}`}>
                  <td>{CHANNEL_KEY_LABELS[s.source] ? <span className="pill border-line">{t(CHANNEL_KEY_LABELS[s.source])}</span> : s.source}</td>
                  <td className="text-ink-2">{s.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(s.installs)}</td>
                  <td className="text-end tabular-nums">{num(s.deterministic)}</td>
                  <td className="text-end tabular-nums">{num(s.reported)}</td>
                  <td className="text-end tabular-nums">{num(s.probabilistic)}</td>
                  <td className="text-end tabular-nums">{num(s.reengagements)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Conversions and revenue by campaign")}</h2>
        <p className="px-5 text-sm text-ink-3">{t("Last touch: each conversion counts for the latest install or re-engagement of that person before it, within the conversion window. Amounts are in the currency the event was sent in, never converted.")}</p>
        {r.byCampaign.length === 0 ? (
          <p className="px-5 pb-5 pt-3 text-sm text-ink-3">{t("No conversion events yet. Conversions are the events your tracking plan marks as conversion or revenue (for example purchase_completed).")}</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>{t("Source")}</th><th>{t("Campaign")}</th><th className="text-end">{t("Conversions")}</th><th className="text-end">{t("Revenue")}</th></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={`${c.source}:${c.campaign}`}>
                  <td>{CHANNEL_KEY_LABELS[c.source] ? <span className="pill border-line">{t(CHANNEL_KEY_LABELS[c.source])}</span> : c.source}</td>
                  <td className="text-ink-2">{c.campaign ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(c.conversions)}</td>
                  <td className="text-end tabular-nums">{c.revenue.length ? c.revenue.map((x) => `${money(x.amount)} ${x.currency}`).join(" · ") : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-sm text-ink-3">
        {rich(t("Spend entered on the {spend} page gives CPI and CPA above, and return and ROAS in Revenue by channel."), { spend: spendLink })}
      </p>
    </div>
  );
}
