import Link from "next/link";
import { createLinkAction, setLinkStatusAction } from "@/app/actions/attribution";
import { AcquisitionHeader, num } from "@/components/acquisition/AcquisitionHeader";
import { LinkShareCard } from "@/components/acquisition/LinkShareCard";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { listLinks } from "@/modules/attribution/service";
import { linkUrl } from "@/modules/deeplinks/pure";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { rich, statusName } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Tracking links & QR") };
}

export default async function LinksPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/links">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = await pickEnvironment(environments, sp.env);
  const [links, config] = await Promise.all([listLinks(ctx, a.id, env.id), can(ctx.role, "deep_links.read") ? getConfig(ctx, a.id, env.id) : null]);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/acquisition`;
  const linkBase = configLinkBase(config);
  const urlOf = (code: string) => linkUrl(linkBase, code, config?.link_prefix ?? null);
  const selected = links.find((l) => l.code === sp.link) ?? null;
  const t = await getT();

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/links" env={env.type} title={t("Tracking links & QR")}
        description={t("One link per campaign, ad or placement. It sends iPhone users to the App Store, Android users to Google Play with the click id in the install referrer, and everyone else to your web page. Clicks from crawlers, link previews and prefetches are not counted. Installs only match clicks of the same environment.")} />

      {selected && <LinkShareCard link={selected} url={urlOf(selected.code)} env={env.type} sp={sp} />}

      <section className="card overflow-x-auto p-0">
        {links.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">{t("No links in this environment yet.")}</p>
        ) : (
          <table className="table">
            <thead><tr><th>{t("Link")}</th><th>{t("Source / campaign")}</th><th>{t("Destinations")}</th><th className="text-end">{t("Clicks (7d)")}</th><th className="text-end">{t("Clicks")}</th><th className="text-end">{t("Installs")}</th><th></th></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium">{l.name}{l.status !== "active" && <span className="pill ms-2 border-line">{statusName(t, l.status)}</span>}</div>
                    <code className="font-mono text-xs break-all text-ink-2" dir="ltr">{urlOf(l.code)}</code>
                  </td>
                  <td className="text-sm">
                    <div>{l.source}{l.medium ? ` / ${l.medium}` : ""}</div>
                    <div className="text-ink-3">{[l.campaign, l.ad_group, l.creative].filter(Boolean).join(" · ") || "–"}</div>
                  </td>
                  <td className="text-xs text-ink-2">
                    {l.ios_url && <div dir="ltr">iOS: App Store</div>}
                    {l.android_url && <div dir="ltr">Android: Google Play</div>}
                    {l.web_url && <div>{t("Web fallback")}</div>}
                    {l.deep_link_path && <div className="font-mono" dir="ltr">{l.deep_link_path}</div>}
                  </td>
                  <td className="text-end tabular-nums">{num(l.clicks_7d)}</td>
                  <td className="text-end tabular-nums">{num(l.clicks)}</td>
                  <td className="text-end tabular-nums">{num(l.installs)}</td>
                  <td className="space-y-1">
                    <Link href={`${base}/links?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">{t("URL & QR")}</Link>
                    {manage && (
                      <ActionForm
                        action={setLinkStatusAction.bind(null, org, app, l.id, l.status === "active" ? "paused" : "active")}
                        submitLabel={l.status === "active" ? t("Pause") : t("Resume")}
                        buttonClass="btn-secondary min-h-8 px-3"
                        className=""
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">{t("New link")}</h2>
          <ActionForm action={createLinkAction.bind(null, org, app)} submitLabel={t("Create link")} className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" required maxLength={120} placeholder={t("Ramadan TikTok – KSA")} /></label>
              <label className="block"><span className="label">{t("Source")}</span><input name="source" className="input" required maxLength={100} placeholder="tiktok, snapchat, google, instagram…" /></label>
              <label className="block"><span className="label">{t("Medium")}</span><input name="medium" className="input" maxLength={100} placeholder="paid_social" /></label>
              <label className="block"><span className="label">{t("Campaign")}</span><input name="campaign" className="input" maxLength={100} placeholder="ramadan_2026" /></label>
              <label className="block"><span className="label">{t("Ad group")}</span><input name="adGroup" className="input" maxLength={100} /></label>
              <label className="block"><span className="label">{t("Creative")}</span><input name="creative" className="input" maxLength={100} /></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("App Store URL")}</span><input name="iosUrl" type="url" className="input" placeholder="https://apps.apple.com/app/id123456789" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Google Play URL")}</span><input name="androidUrl" type="url" className="input" placeholder="https://play.google.com/store/apps/details?id=com.example" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Web fallback URL")}</span><input name="webUrl" type="url" className="input" placeholder="https://example.com/app" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Deep link (optional)")}</span><input name="deepLinkPath" className="input" maxLength={500} placeholder="/offers/ramadan" dir="ltr" />
                <span className="help">{t("Where the app opens when it is installed and deep links are set up. On Android it also rides in the install referrer; opening it after a fresh install needs the deferred API (Beta, see Deep links).")}</span></label>
            </div>
            <p className="text-xs text-ink-3">
              {rich(t("Ad networks can fill campaign labels per ad: add {params} to the link, plus their click id ({ids}) when they append it."), {
                params: <code className="font-mono" dir="ltr">?utm_campaign=…&amp;utm_term=…&amp;utm_content=…</code>,
                ids: <span dir="ltr"><code className="font-mono">gclid</code>, <code className="font-mono">ttclid</code>, <code className="font-mono">ScCid</code>, <code className="font-mono">fbclid</code></span>,
              })}
            </p>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
