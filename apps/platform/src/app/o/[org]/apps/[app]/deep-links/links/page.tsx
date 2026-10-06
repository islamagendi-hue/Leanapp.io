import Link from "next/link";
import { createChannelLinkAction } from "@/app/actions/deep-links";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { listLinks } from "@/modules/attribution/service";
import { can } from "@/modules/rbac/authorize";
import { CHANNEL_PRESETS, linkUrl } from "@/modules/deeplinks/pure";
import { qrSvg } from "@/modules/deeplinks/qr";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Link builder" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim().slice(0, 100) : "");

export default async function LinkBuilderPage(props: PageProps<"/o/[org]/apps/[app]/deep-links/links">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = pickEnvironment(environments, sp.env ?? "production");
  const [links, config] = await Promise.all([listLinks(ctx, a.id, env.id), can(ctx.role, "deep_links.read") ? getConfig(ctx, a.id, env.id) : null]);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/deep-links/links`;
  const linkBase = configLinkBase(config);
  const urlOf = (code: string) => linkUrl(linkBase, code, config?.link_prefix ?? null);

  // Selected link: full URL with optional per-placement overrides, and its QR code.
  const selected = links.find((l) => l.code === str(sp.link)) ?? null;
  const overrides = { utm_campaign: str(sp.utm_campaign), utm_content: str(sp.utm_content) };
  let shareUrl = "";
  let svg = "";
  if (selected) {
    const u = new URL(urlOf(selected.code));
    for (const [k, v] of Object.entries(overrides)) if (v) u.searchParams.set(k, v);
    shareUrl = u.toString();
    svg = qrSvg(shareUrl, { title: `QR code for ${selected.name}` });
  }
  const iosDefault = config?.ios_app_store_id ? `https://apps.apple.com/app/id${config.ios_app_store_id}` : "";
  const androidId = config?.android_play_store_id ?? config?.android_package;
  const androidDefault = androidId ? `https://play.google.com/store/apps/details?id=${androidId}` : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Link builder</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            One link works in every channel: ads, email, SMS, WhatsApp, QR codes, influencers and your website. It opens the app when installed, goes to the store when not,
            and carries the deep link through the install. Use one link per channel or placement so reports stay clean.
          </p>
        </div>
        <EnvSwitcher path={base} current={env.type} />
      </div>
      {!config && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Deep links aren&apos;t set up for {env.type} yet, so links redirect to the stores but won&apos;t open an installed app.{" "}
          <Link href={`/o/${org}/apps/${app}/deep-links?env=${env.type}`} className="underline">Set them up</Link>.
        </p>
      )}

      {selected && (
        <section className="card grid gap-6 md:grid-cols-[1fr_220px]">
          <div className="space-y-3">
            <h2 className="h2">{selected.name}</h2>
            <p className="text-sm text-ink-2">{selected.source}{selected.medium ? ` / ${selected.medium}` : ""}{selected.campaign ? ` · ${selected.campaign}` : ""}{selected.deep_link_path ? ` → ${selected.deep_link_path}` : ""}</p>
            <code className="code block break-all" dir="ltr">{shareUrl}</code>
            <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <input type="hidden" name="env" value={env.type} />
              <input type="hidden" name="link" value={selected.code} />
              <label className="block"><span className="label">Campaign (override)</span><input name="utm_campaign" className="input" defaultValue={overrides.utm_campaign} placeholder={selected.campaign ?? "eid_2026"} /></label>
              <label className="block"><span className="label">Placement / creative</span><input name="utm_content" className="input" defaultValue={overrides.utm_content} placeholder="poster_riyadh_park" /></label>
              <button type="submit" className="btn-secondary">Update</button>
            </form>
            <p className="help">Overrides are added to the URL (utm_campaign, utm_content) and recorded with each click; source and medium stay the link&apos;s.</p>
          </div>
          <div className="space-y-2">
            <div className="rounded-lg border border-line bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
            <a className="btn-secondary w-full justify-center" download={`leanapp-${selected.code}.svg`} href={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`}>Download SVG</a>
          </div>
        </section>
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
                  <td><Link href={`${base}?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">URL &amp; QR</Link></td>
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
