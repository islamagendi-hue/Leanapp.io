import Link from "next/link";
import { redirect } from "next/navigation";
import { createChannelLinkAction } from "@/app/actions/deep-links";
import { AcquisitionHeader } from "@/components/acquisition/AcquisitionHeader";
import { ActionForm } from "@/components/ActionForm";
import { listLinks } from "@/modules/attribution/service";
import { can } from "@/modules/rbac/authorize";
import { CHANNEL_PRESETS, linkUrl } from "@/modules/deeplinks/pure";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Deep links" };

export default async function LinkBuilderPage(props: PageProps<"/o/[org]/apps/[app]/acquisition/deep-links">) {
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
  const [links, config] = await Promise.all([listLinks(ctx, a.id, env.id), can(ctx.role, "deep_links.read") ? getConfig(ctx, a.id, env.id) : null]);
  const manage = can(ctx.role, "attribution.manage");
  const linkBase = configLinkBase(config);
  const urlOf = (code: string) => linkUrl(linkBase, code, config?.link_prefix ?? null);

  const iosDefault = config?.ios_app_store_id ? `https://apps.apple.com/app/id${config.ios_app_store_id}` : "";
  const androidId = config?.android_play_store_id ?? config?.android_package;
  const androidDefault = androidId ? `https://play.google.com/store/apps/details?id=${androidId}` : "";

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/deep-links" env={env.type} title="Deep links"
        description="One link works in every channel: ads, email, SMS, WhatsApp, QR codes, influencers and your website. It opens the app when installed, goes to the store when not, and carries the deep link through the install. Use one link per channel or placement so reports stay clean." />
      {!config && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Deep links aren&apos;t set up for {env.type} yet, so links redirect to the stores but won&apos;t open an installed app.{" "}
          <Link href={`/o/${org}/apps/${app}/settings/dev-ops/deep-links?env=${env.type}`} className="underline">Set them up</Link>.
        </p>
      )}

      <section className="card overflow-x-auto p-0">
        {links.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No links in this environment yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Link</th><th>Channel</th><th>Deep link</th><th className="text-end">Clicks (7d)</th><th></th></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium">{l.name}{l.status !== "active" && <span className="pill ms-2 border-line">{l.status}</span>}</div>
                    <code className="font-mono text-xs break-all text-ink-2" dir="ltr">{urlOf(l.code)}</code>
                  </td>
                  <td className="text-sm">{l.source}{l.medium ? ` / ${l.medium}` : ""}<div className="text-ink-3">{[l.campaign, l.creative].filter(Boolean).join(" · ") || "–"}</div></td>
                  <td className="font-mono text-xs" dir="ltr">{l.deep_link_path ?? "–"}</td>
                  <td className="text-end tabular-nums">{l.clicks_7d.toLocaleString("en-US")}</td>
                  <td><Link href={`${base}/links?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">URL &amp; QR</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">New link</h2>
          <ActionForm action={createChannelLinkAction.bind(null, org, app)} submitLabel="Create link" className="space-y-4">
            <input type="hidden" name="environmentId" value={env.id} />
            <fieldset className="space-y-2">
              <legend className="label">Channel</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {CHANNEL_PRESETS.map((p, i) => (
                  <label key={p.id} className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm">
                    <input type="radio" name="channel" value={p.id} defaultChecked={i === 0} className="mt-1" />
                    <span><span className="font-medium">{p.label}</span><span className="help block">{p.source} / {p.medium}. {p.hint}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">Name</span><input name="name" className="input" required maxLength={120} placeholder="Eid newsletter – hero button" /></label>
              <label className="block"><span className="label">Deep link</span><input name="deepLinkPath" className="input font-mono" maxLength={500} placeholder="/offers/eid?promo=EID10" dir="ltr" />
                <span className="help">Where the app should open. Query parameters reach your handler as params.</span></label>
              <label className="block"><span className="label">Campaign</span><input name="campaign" className="input" maxLength={100} placeholder="eid_2026" /></label>
              <label className="block"><span className="label">Creative / placement / influencer</span><input name="creative" className="input" maxLength={100} placeholder="@handle or poster_mall" /></label>
              <label className="block"><span className="label">Source (optional override)</span><input name="source" className="input" maxLength={100} placeholder="From the channel" /></label>
              <label className="block"><span className="label">Medium (optional override)</span><input name="medium" className="input" maxLength={100} placeholder="From the channel" /></label>
              <label className="block"><span className="label">App Store URL</span><input name="iosUrl" type="url" className="input" defaultValue={iosDefault} placeholder="https://apps.apple.com/app/id123456789" dir="ltr" /></label>
              <label className="block"><span className="label">Google Play URL</span><input name="androidUrl" type="url" className="input" defaultValue={androidDefault} placeholder="https://play.google.com/store/apps/details?id=com.example" dir="ltr" /></label>
              <label className="block sm:col-span-2"><span className="label">Web fallback URL</span><input name="webUrl" type="url" className="input" placeholder="https://example.com/app" dir="ltr" />
                <span className="help">Desktop visitors (e.g. a QR code scanned on a laptop webcam, an email opened on a computer) go here.</span></label>
            </div>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
