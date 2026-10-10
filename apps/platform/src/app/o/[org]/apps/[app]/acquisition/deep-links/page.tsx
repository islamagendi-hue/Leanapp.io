import Link from "next/link";
import { redirect } from "next/navigation";
import { createChannelLinkAction } from "@/app/actions/deep-links";
import { AcquisitionHeader, AcquisitionRange, num } from "@/components/acquisition/AcquisitionHeader";
import { ActionForm } from "@/components/ActionForm";
import { rangeFromParams, toSearch } from "@/modules/analytics/report-params";
import { CAPABILITY_STATUS_LABELS, deepLinkCapabilities, type CapabilityStatus } from "@/modules/deeplinks/capabilities";
import { deepLinkReport } from "@/modules/deeplinks/report";
import { can } from "@/modules/rbac/authorize";
import { GROUP_LABELS } from "@/modules/channels/registry";
import { CHANNEL_PRESETS, linkUrl } from "@/modules/deeplinks/pure";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { envName, statusName } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Deep links") };
}

const STATUS_CLASS: Record<CapabilityStatus, string> = {
  live: "border-accent/40 bg-accent-soft text-accent-ink",
  beta: "border-warn/40 bg-warn-soft text-warn",
  unverified: "border-warn/40 bg-warn-soft text-warn",
  needs_setup: "border-line text-ink-3",
  off: "border-line text-ink-3",
};

export default async function DeepLinksPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/deep-links">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const base = `/o/${org}/apps/${app}/acquisition`;
  // A link's URL & QR code moved to Tracking links & QR; keep old addresses working.
  if (typeof sp.link === "string") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
    redirect(`${base}/links?${q}`);
  }
  const [report, config] = await Promise.all([deepLinkReport(ctx, { environmentId: env.id, timezone: a.timezone }, rangeFromParams(toSearch(sp))), can(ctx.role, "deep_links.read") ? getConfig(ctx, a.id, env.id) : null]);
  const capabilities = deepLinkCapabilities(config);
  const setupHref = `/o/${org}/apps/${app}/settings/dev-ops/deep-links?env=${env.type}`;
  const d = report.deferred;
  const t = await getT();
  const manage = can(ctx.role, "attribution.manage");
  const linkBase = configLinkBase(config);
  const urlOf = (code: string) => linkUrl(linkBase, code, config?.link_prefix ?? null);

  const iosDefault = config?.ios_app_store_id ? `https://apps.apple.com/app/id${config.ios_app_store_id}` : "";
  const androidId = config?.android_play_store_id ?? config?.android_package;
  const androidDefault = androidId ? `https://play.google.com/store/apps/details?id=${androidId}` : "";

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/deep-links" env={env.type} title={t("Deep links")}
        description={t("Links that open your app on a specific screen when it is installed, and go to the store or your web page when it isn't. Use them in ads, email, SMS, WhatsApp, QR codes, influencer posts and your website. The technical setup (domains, app associations) is in Settings → Dev Ops → Deep link setup.")} />

      <section className="card space-y-3" aria-label={t("What works today")}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">{t("What works today in {env}", { env: envName(t, env.type) })}</h2>
          <Link href={setupHref} className="text-sm underline">{t("Deep link setup")}</Link>
        </div>
        <ul className="divide-y divide-line">
          {capabilities.map((c) => (
            <li key={c.key} data-capability={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="max-w-2xl"><p className="font-medium">{t(c.label)}</p><p className="text-sm text-ink-2">{t(c.detail)}</p></div>
              <span className={`pill text-xs ${STATUS_CLASS[c.status]}`}>{t(CAPABILITY_STATUS_LABELS[c.status])}</span>
            </li>
          ))}
        </ul>
      </section>

      <AcquisitionRange env={env.type} range={report.range} />
      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">{t("Links with a deep link")}</h2>
        <p className="px-5 text-sm text-ink-3">
          {d.deterministic + d.probabilistic + d.none > 0
            ? t("Re-engagements are opens of the installed app through the link. Deferred matches are first opens after install that asked the deferred API and got this link (in this range: {exact} exact, {probabilistic} probabilistic, {none} without a match).", { exact: num(d.deterministic), probabilistic: num(d.probabilistic), none: num(d.none) })
            : t("Re-engagements are opens of the installed app through the link. Deferred matches are first opens after install that asked the deferred API and got this link.")}
        </p>
        {report.links.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">{t("No links with a deep link in this environment yet.")}</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>{t("Link")}</th><th>{t("Opens at")}</th><th className="text-end">{t("Clicks")}</th><th className="text-end">{t("Installs")}</th><th className="text-end">{t("Re-engagements")}</th><th className="text-end">{t("Deferred matches")}</th><th></th></tr></thead>
            <tbody>
              {report.links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium">{l.name}{l.status !== "active" && <span className="pill ms-2 border-line">{statusName(t, l.status)}</span>}</div>
                    <code className="font-mono text-xs break-all text-ink-2" dir="ltr">{urlOf(l.code)}</code>
                  </td>
                  <td className="font-mono text-xs" dir="ltr">{l.deep_link_path}</td>
                  <td className="text-end tabular-nums">{num(l.clicks)}</td>
                  <td className="text-end tabular-nums">{num(l.installs)}</td>
                  <td className="text-end tabular-nums">{num(l.reengagements)}</td>
                  <td className="text-end tabular-nums">{num(l.deferred)}</td>
                  <td><Link href={`${base}/links?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">{t("URL & QR")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">{t("New deep link")}</h2>
          <ActionForm action={createChannelLinkAction.bind(null, org, app)} submitLabel={t("Create link")} className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <fieldset className="space-y-2">
              <legend className="label">{t("Channel")}</legend>
              {(["owned", "referral", "organic", "paid"] as const).map((g) => (
                <div key={g} className="space-y-2">
                  <p className="text-sm font-medium text-ink-2">{t(GROUP_LABELS[g])}</p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {CHANNEL_PRESETS.filter((p) => p.group === g).map((p) => (
                      <label key={p.id} className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm">
                        <input type="radio" name="channel" value={p.id} defaultChecked={p.id === "email"} className="mt-1" />
                        <span><span className="font-medium">{t(p.label)}</span><span className="help block"><span dir="ltr">{p.source} / {p.medium}</span>. {t(p.hint)}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" required maxLength={120} placeholder={t("Eid newsletter – hero button")} /></label>
              <label className="block"><span className="label">{t("Deep link")}</span><input name="deepLinkPath" className="input font-mono" maxLength={500} placeholder="/offers/eid?promo=EID10" dir="ltr" />
                <span className="help">{t("The screen to open, returned with its query parameters by the resolve API when the app opens from the link.")}</span></label>
              <label className="block"><span className="label">{t("Campaign")}</span><input name="campaign" className="input" maxLength={100} placeholder="eid_2026" /></label>
              <label className="block"><span className="label">{t("Ad group")}</span><input name="adGroup" className="input" maxLength={100} placeholder="riyadh_women_25_34" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Creative / placement / influencer")}</span><input name="creative" className="input" maxLength={100} placeholder={t("@handle or poster_mall")} /></label>
              <label className="block"><span className="label">{t("Source (optional override)")}</span><input name="source" className="input" maxLength={100} placeholder={t("From the channel")} /></label>
              <label className="block"><span className="label">{t("Medium (optional override)")}</span><input name="medium" className="input" maxLength={100} placeholder={t("From the channel")} /></label>
              <label className="block"><span className="label">{t("App Store URL")}</span><input name="iosUrl" type="url" className="input" defaultValue={iosDefault} placeholder="https://apps.apple.com/app/id123456789" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Google Play URL")}</span><input name="androidUrl" type="url" className="input" defaultValue={androidDefault} placeholder="https://play.google.com/store/apps/details?id=com.example" dir="ltr" /></label>
              <label className="block sm:col-span-2"><span className="label">{t("Web fallback URL")}</span><input name="webUrl" type="url" className="input" placeholder="https://example.com/app" dir="ltr" />
                <span className="help">{t("Desktop visitors (e.g. a QR code scanned on a laptop webcam, an email opened on a computer) go here.")}</span></label>
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
