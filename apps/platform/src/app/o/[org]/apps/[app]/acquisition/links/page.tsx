import Link from "next/link";
import { createLinkAction, setLinkStatusAction } from "@/app/actions/attribution";
import { AcquisitionHeader, num } from "@/components/acquisition/AcquisitionHeader";
import { LinkShareCard } from "@/components/acquisition/LinkShareCard";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { listLinks } from "@/modules/attribution/service";
import { linkUrl } from "@/modules/deeplinks/pure";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Tracking links & QR" };

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

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/links" env={env.type} title="Tracking links & QR"
        description="One link per campaign, ad or placement. It sends iPhone users to the App Store, Android users to Google Play with the click id in the install referrer, and everyone else to your web page. Clicks from crawlers, link previews and prefetches are not counted. Installs only match clicks of the same environment." />

      {selected && <LinkShareCard link={selected} url={urlOf(selected.code)} env={env.type} sp={sp} />}

      <section className="card overflow-x-auto p-0">
        {links.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No links in this environment yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Link</th><th>Source / campaign</th><th>Destinations</th><th className="text-end">Clicks (7d)</th><th className="text-end">Clicks</th><th className="text-end">Installs</th><th></th></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium">{l.name}{l.status !== "active" && <span className="pill ms-2 border-line">{l.status}</span>}</div>
                    <code className="font-mono text-xs break-all text-ink-2" dir="ltr">{urlOf(l.code)}</code>
                  </td>
                  <td className="text-sm">
                    <div>{l.source}{l.medium ? ` / ${l.medium}` : ""}</div>
                    <div className="text-ink-3">{[l.campaign, l.ad_group, l.creative].filter(Boolean).join(" · ") || "–"}</div>
                  </td>
                  <td className="text-xs text-ink-2">
                    {l.ios_url && <div>iOS: App Store</div>}
                    {l.android_url && <div>Android: Google Play</div>}
                    {l.web_url && <div>Web fallback</div>}
                    {l.deep_link_path && <div className="font-mono">{l.deep_link_path}</div>}
                  </td>
                  <td className="text-end tabular-nums">{num(l.clicks_7d)}</td>
                  <td className="text-end tabular-nums">{num(l.clicks)}</td>
                  <td className="text-end tabular-nums">{num(l.installs)}</td>
                  <td className="space-y-1">
                    <Link href={`${base}/links?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">URL &amp; QR</Link>
                    {manage && (
                      <ActionForm
                        action={setLinkStatusAction.bind(null, org, app, l.id, l.status === "active" ? "paused" : "active")}
                        submitLabel={l.status === "active" ? "Pause" : "Resume"}
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
          <h2 className="h2">New link</h2>
          <ActionForm action={createLinkAction.bind(null, org, app)} submitLabel="Create link" className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">Name</span><input name="name" className="input" required maxLength={120} placeholder="Ramadan TikTok – KSA" /></label>
              <label className="block"><span className="label">Source</span><input name="source" className="input" required maxLength={100} placeholder="tiktok, snapchat, google, instagram…" /></label>
              <label className="block"><span className="label">Medium</span><input name="medium" className="input" maxLength={100} placeholder="paid_social" /></label>
              <label className="block"><span className="label">Campaign</span><input name="campaign" className="input" maxLength={100} placeholder="ramadan_2026" /></label>
              <label className="block"><span className="label">Ad group</span><input name="adGroup" className="input" maxLength={100} /></label>
              <label className="block"><span className="label">Creative</span><input name="creative" className="input" maxLength={100} /></label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">App Store URL</span><input name="iosUrl" type="url" className="input" placeholder="https://apps.apple.com/app/id123456789" /></label>
              <label className="block"><span className="label">Google Play URL</span><input name="androidUrl" type="url" className="input" placeholder="https://play.google.com/store/apps/details?id=com.example" /></label>
              <label className="block"><span className="label">Web fallback URL</span><input name="webUrl" type="url" className="input" placeholder="https://example.com/app" /></label>
              <label className="block"><span className="label">Deep link (optional)</span><input name="deepLinkPath" className="input" maxLength={500} placeholder="/offers/ramadan" />
                <span className="help">Passed to the app in the install referrer (Android) for deferred deep linking.</span></label>
            </div>
            <p className="text-xs text-ink-3">
              Ad networks can fill campaign labels per ad: add <code className="font-mono">?utm_campaign=…&amp;utm_term=…&amp;utm_content=…</code> to the link, plus their click id
              (<code className="font-mono">gclid</code>, <code className="font-mono">ttclid</code>, <code className="font-mono">ScCid</code>, <code className="font-mono">fbclid</code>) when they append it.
            </p>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
