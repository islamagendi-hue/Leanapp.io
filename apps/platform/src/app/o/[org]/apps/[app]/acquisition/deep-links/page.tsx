import Link from "next/link";
import { redirect } from "next/navigation";
import { createChannelLinkAction } from "@/app/actions/deep-links";
import { AcquisitionHeader, AcquisitionRange, num } from "@/components/acquisition/AcquisitionHeader";
import { ActionForm } from "@/components/ActionForm";
import { param } from "@/components/AnalyticsHeader";
import { ATTRIBUTION_RANGES } from "@/modules/attribution/reports";
import { CAPABILITY_STATUS_LABELS, deepLinkCapabilities, type CapabilityStatus } from "@/modules/deeplinks/capabilities";
import { deepLinkReport } from "@/modules/deeplinks/report";
import { can } from "@/modules/rbac/authorize";
import { CHANNEL_PRESETS, linkUrl } from "@/modules/deeplinks/pure";
import { configLinkBase, getConfig } from "@/modules/deeplinks/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Deep links" };

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
  const [report, config] = await Promise.all([deepLinkReport(ctx, env.id, param(sp.days)), can(ctx.role, "deep_links.read") ? getConfig(ctx, a.id, env.id) : null]);
  const capabilities = deepLinkCapabilities(config);
  const setupHref = `/o/${org}/apps/${app}/settings/dev-ops/deep-links?env=${env.type}`;
  const d = report.deferred;
  const manage = can(ctx.role, "attribution.manage");
  const linkBase = configLinkBase(config);
  const urlOf = (code: string) => linkUrl(linkBase, code, config?.link_prefix ?? null);

  const iosDefault = config?.ios_app_store_id ? `https://apps.apple.com/app/id${config.ios_app_store_id}` : "";
  const androidId = config?.android_play_store_id ?? config?.android_package;
  const androidDefault = androidId ? `https://play.google.com/store/apps/details?id=${androidId}` : "";

  return (
    <div className="space-y-6">
      <AcquisitionHeader base={base} current="/deep-links" env={env.type} title="Deep links"
        description="Links that open your app on a specific screen when it is installed, and go to the store or your web page when it isn't. Use them in ads, email, SMS, WhatsApp, QR codes, influencer posts and your website. The technical setup (domains, app associations) is in Settings → Dev Ops → Deep link setup." />

      <section className="card space-y-3" aria-label="What works today">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="h2">What works today in {env.type}</h2>
          <Link href={setupHref} className="text-sm underline">Deep link setup</Link>
        </div>
        <ul className="divide-y divide-line">
          {capabilities.map((c) => (
            <li key={c.key} data-capability={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="max-w-2xl"><p className="font-medium">{c.label}</p><p className="text-sm text-ink-2">{c.detail}</p></div>
              <span className={`pill text-xs ${STATUS_CLASS[c.status]}`}>{CAPABILITY_STATUS_LABELS[c.status]}</span>
            </li>
          ))}
        </ul>
      </section>

      <AcquisitionRange env={env.type} days={report.days} ranges={ATTRIBUTION_RANGES} />
      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-5">Links with a deep link</h2>
        <p className="px-5 text-sm text-ink-3">
          Re-engagements are opens of the installed app through the link. Deferred matches are first opens after install that asked the deferred API and got this link
          {d.deterministic + d.probabilistic + d.none > 0 ? ` (in this range: ${num(d.deterministic)} exact, ${num(d.probabilistic)} probabilistic, ${num(d.none)} without a match)` : ""}.
        </p>
        {report.links.length === 0 ? (
          <p className="p-5 text-sm text-ink-3">No links with a deep link in this environment yet.</p>
        ) : (
          <table className="table mt-3">
            <thead><tr><th>Link</th><th>Opens at</th><th className="text-end">Clicks</th><th className="text-end">Installs</th><th className="text-end">Re-engagements</th><th className="text-end">Deferred matches</th><th></th></tr></thead>
            <tbody>
              {report.links.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="font-medium">{l.name}{l.status !== "active" && <span className="pill ms-2 border-line">{l.status}</span>}</div>
                    <code className="font-mono text-xs break-all text-ink-2" dir="ltr">{urlOf(l.code)}</code>
                  </td>
                  <td className="font-mono text-xs" dir="ltr">{l.deep_link_path}</td>
                  <td className="text-end tabular-nums">{num(l.clicks)}</td>
                  <td className="text-end tabular-nums">{num(l.installs)}</td>
                  <td className="text-end tabular-nums">{num(l.reengagements)}</td>
                  <td className="text-end tabular-nums">{num(l.deferred)}</td>
                  <td><Link href={`${base}/links?env=${env.type}&link=${l.code}`} className="btn-secondary min-h-8 px-3">URL &amp; QR</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manage && (
        <section className="card space-y-4">
          <h2 className="h2">New deep link</h2>
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
                <span className="help">The screen to open, returned with its query parameters by the resolve API when the app opens from the link.</span></label>
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
