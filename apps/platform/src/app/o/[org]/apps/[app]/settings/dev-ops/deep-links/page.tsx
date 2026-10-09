import Link from "next/link";
import { checkWellKnownAction, saveDeepLinkConfigAction } from "@/app/actions/deep-links";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { buildAasa, buildAssetLinks, hostnameOf } from "@/modules/deeplinks/pure";
import { associationsForHost, configLinkBase, defaultLinkHost, getConfig, suggestPrefix, type WellKnownCheck } from "@/modules/deeplinks/service";
import { envName, rich } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Deep links") };
}

const FILE_LABEL: Record<WellKnownCheck["file"], string> = {
  "apple-app-site-association": "apple-app-site-association (iOS)",
  "assetlinks.json": "assetlinks.json (Android)",
  "apple-cdn": msg("Apple CDN copy"),
};

function Pre({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-paper-2 p-3 font-mono text-xs leading-relaxed" dir="ltr">{children}</pre>;
}

export default async function DeepLinksPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/deep-links">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "deep_links.read");
  const env = await pickEnvironment(environments, sp.env);
  const config = await getConfig(ctx, a.id, env.id);
  const manage = can(ctx.role, "deep_links.manage");
  const base = `/o/${org}/apps/${app}/settings/dev-ops/deep-links`;
  const linkBase = configLinkBase(config);
  const host = hostnameOf(linkBase)!;
  const prefix = config?.link_prefix ?? suggestPrefix(a.slug, env.type);
  const mine = config ? (await associationsForHost(host)).filter((c) => c.link_prefix === config.link_prefix) : [];
  const ios = Boolean(config?.ios_team_id && config.ios_bundle_ids.length);
  const android = Boolean(config?.android_package && config.android_sha256.length);
  const checks = config?.last_check ?? null;
  const sharedHost = !config?.custom_domain && host === defaultLinkHost();
  const t = await getT();
  const envWord = envName(t, env.type);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Deep links")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {t("Tracking links that open your app directly when it is installed (iOS Universal Links, Android App Links) and go to the store when it isn't. Each environment has its own setup, so development builds never open production links. What works for your campaigns is summarized in Acquisition → Deep links.")}
          </p>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="label">{t("Link format")}</p>
          <code className="font-mono text-sm break-all" dir="ltr">{linkBase}/l/{prefix}/&lt;code&gt;</code>
          <p className="help mt-1">{config ? t("Links of this environment.") : t("Suggested; save the settings to use it.")}</p>
        </div>
        <div className="card">
          <p className="label">iOS Universal Links</p>
          <p className="font-medium">{ios ? t("Configured") : t("Not configured")}</p>
          <p className="help mt-1">{ios ? t("{n} bundle id(s), team {team}", { n: config!.ios_bundle_ids.length, team: config!.ios_team_id ?? "" }) : t("Add your Team ID and bundle id.")}</p>
        </div>
        <div className="card">
          <p className="label">Android App Links</p>
          <p className="font-medium">{android ? t("Configured") : t("Not configured")}</p>
          <p className="help mt-1">{android ? t("{package}, {n} certificate(s)", { package: config!.android_package ?? "", n: config!.android_sha256.length }) : t("Add the package name and signing certificate fingerprint.")}</p>
        </div>
      </section>

      {config && (
        <section className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="h2">{t("Association files")}</h2>
              <p className="text-sm text-ink-2">
                {rich(t("Fetched from {url} the way Apple and Google fetch them: https, status 200, JSON, no redirect."), { url: <code className="font-mono" dir="ltr">{linkBase}/.well-known/…</code> })}
                {config.last_checked_at && <> {t("Last tested {time} UTC.", { time: config.last_checked_at.toISOString().slice(0, 16).replace("T", " ") })}</>}
              </p>
            </div>
            {manage && (ios || android) && (
              <ActionForm action={checkWellKnownAction.bind(null, org, app, env.id)} submitLabel={t("Test")} pendingLabel={t("Testing…")} buttonClass="btn-secondary" className="space-y-2" />
            )}
          </div>
          {checks && checks.length > 0 && (
            <table className="table">
              <thead><tr><th>{t("File")}</th><th>{t("Status")}</th><th>{t("Result")}</th></tr></thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.file}>
                    <td><div className="font-medium">{t(FILE_LABEL[c.file])}</div><code className="font-mono text-xs break-all text-ink-3" dir="ltr">{c.url}</code></td>
                    <td className="tabular-nums">{c.status ?? "–"}</td>
                    <td className="text-sm">
                      {c.ok ? <span className="pill border-accent text-accent-ink">{t("OK")}</span> : <span className={`pill ${c.warning ? "border-warn text-warn" : "border-alert text-alert"}`}>{c.warning ? t("Warning") : t("Failed")}</span>}
                      {c.problems.length > 0 && <ul className="mt-1 list-disc ps-5 text-ink-2">{c.problems.map((p) => <li key={p}>{t(p)}</li>)}</ul>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary className="cursor-pointer text-sm text-ink-2">{sharedHost ? t("This environment's entries (the host also lists other apps, each under its own prefix)") : t("This environment's entries")}</summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <Pre>{JSON.stringify(buildAasa(mine), null, 2)}</Pre>
              <Pre>{JSON.stringify(buildAssetLinks(mine), null, 2)}</Pre>
            </div>
          </details>
        </section>
      )}

      {manage ? (
        <section className="card space-y-4">
          <h2 className="h2">{t("Settings for {env}", { env: envWord })}</h2>
          <ActionForm action={saveDeepLinkConfigAction.bind(null, org, app)} submitLabel={t("Save")} className="space-y-5">
            <input type="hidden" name="environmentId" value={env.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">{t("Link prefix")}</span>
                <input name="linkPrefix" className="input font-mono" required defaultValue={prefix} pattern="[a-z0-9][a-z0-9\-]{1,30}[a-z0-9]" dir="ltr" />
                <span className="help">{rich(t("Links are {format}. Unique across LeanApp; use a different one per environment."), { format: <span dir="ltr">/l/&lt;prefix&gt;/&lt;code&gt;</span> })}</span>
              </label>
              <label className="block"><span className="label">{t("Custom link domain (optional)")}</span>
                <input name="customDomain" className="input font-mono" defaultValue={config?.custom_domain ?? ""} placeholder="links.example.com" dir="ltr" />
                <span className="help">{rich(t("Empty = {host}. See “Custom domain” below before setting one."), { host: <span dir="ltr">{defaultLinkHost()}</span> })}</span>
              </label>
            </div>
            <fieldset className="space-y-3 rounded-lg border border-line p-4">
              <legend className="px-1 font-medium">iOS</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="label">{t("Apple Team ID")}</span>
                  <input name="iosTeamId" className="input font-mono" defaultValue={config?.ios_team_id ?? ""} placeholder="ABCDE12345" maxLength={10} dir="ltr" />
                  <span className="help">{t("Apple Developer → Membership details.")}</span></label>
                <label className="block"><span className="label">{t("Bundle ids")}</span>
                  <input name="iosBundleIds" className="input font-mono" defaultValue={config?.ios_bundle_ids.join(", ") ?? ""} placeholder="com.example.app" dir="ltr" />
                  <span className="help">{t("Comma-separated (app, App Clip). Use the build that runs in {env}.", { env: envWord })}</span></label>
                <label className="block"><span className="label">{t("App Store id")}</span>
                  <input name="iosAppStoreId" className="input font-mono" defaultValue={config?.ios_app_store_id ?? ""} placeholder="123456789" dir="ltr" />
                  <span className="help">{t("The number in apps.apple.com/app/id…; store fallback for links without an App Store URL.")}</span></label>
                <label className="block"><span className="label">{t("URL scheme (optional)")}</span>
                  <input name="uriScheme" className="input font-mono" defaultValue={config?.uri_scheme ?? ""} placeholder="myapp" dir="ltr" />
                  <span className="help">{t("Lets the Open-in-app page open the app from Instagram, TikTok and other in-app browsers on iOS.")}</span></label>
              </div>
            </fieldset>
            <fieldset className="space-y-3 rounded-lg border border-line p-4">
              <legend className="px-1 font-medium">Android</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="label">{t("Package name")}</span>
                  <input name="androidPackage" className="input font-mono" defaultValue={config?.android_package ?? ""} placeholder="com.example.app" dir="ltr" /></label>
                <label className="block"><span className="label">{t("Play Store id (optional)")}</span>
                  <input name="androidPlayStoreId" className="input font-mono" defaultValue={config?.android_play_store_id ?? ""} placeholder={t("Same as the package name")} dir="ltr" /></label>
                <label className="block sm:col-span-2"><span className="label">{t("SHA-256 certificate fingerprints")}</span>
                  <textarea name="androidSha256" className="input font-mono text-xs" rows={2} defaultValue={config?.android_sha256.join("\n") ?? ""} placeholder="14:6D:E9:83:…" dir="ltr" />
                  <span className="help">{t("Play Console → Test and release → App integrity → App signing key certificate (and your upload / debug key for {env} builds). One per line.", { env: envWord })}</span></label>
              </div>
            </fieldset>
            <div className="space-y-2">
              <label className="flex items-start gap-2">
                <input type="checkbox" name="deferredEnabled" defaultChecked={config?.deferred_enabled ?? true} className="mt-1" />
                <span><span className="font-medium">{t("Deferred deep links")}</span><span className="help block">{t("Beta, API only. On its first open after install your app can call POST /v1/deep-links/deferred to get the deep link of the click the install came from (exact match from the Play install referrer or a click id your app passes; probabilistic only if turned on in Attribution settings, Android only). The LeanApp SDKs don't make this call yet.")}</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" name="interstitialEnabled" defaultChecked={config?.interstitial_enabled ?? true} className="mt-1" />
                <span><span className="font-medium">{t("Open-in-app page for social in-app browsers")}</span><span className="help block">{t("Instagram, Facebook, TikTok and Snapchat open links in their own browser, where Universal Links and App Links don't work. Visitors there see an “Open in app” button and a store button instead of a redirect.")}</span></span>
              </label>
            </div>
          </ActionForm>
        </section>
      ) : (
        <p className="text-sm text-ink-3">{t("You can view these settings; changing them needs the deep_links.manage permission (owner, admin, developer).")}</p>
      )}

      <section className="card space-y-4">
        <h2 className="h2">{t("App setup")}</h2>
        <div className="space-y-2">
          <h3 className="font-medium">{t("iOS: Associated Domains")}</h3>
          <p className="text-sm text-ink-2">{t("In Xcode → Signing & Capabilities → Associated Domains (or the entitlements file):")}</p>
          <Pre>{`applinks:${host}`}</Pre>
          <p className="text-sm text-ink-2">{rich(t("Pass incoming links to the SDK from {handlers}:"), { handlers: <span dir="ltr"><code className="font-mono">scene(_:continue:)</code> / <code className="font-mono">onOpenURL</code></span> })}</p>
          <Pre>{`Analytics.onDeepLink { link in router.open(link.path, params: link.params) }\nAnalytics.handleOpenUrl(url)`}</Pre>
        </div>
        <div className="space-y-2">
          <h3 className="font-medium">{t("Android: intent filter")}</h3>
          <Pre>{`<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="${host}" android:pathPrefix="/l/${prefix}/" />
</intent-filter>`}</Pre>
          <Pre>{`Analytics.onDeepLink { link -> navigate(link.path, link.params) }\n// launch intents are handled automatically; for onNewIntent:\nAnalytics.handleOpenUrl(intent.dataString)`}</Pre>
        </div>
        <p className="text-sm text-ink-2">
          {rich(t("React Native and Flutter: see the SDK guide ({functions}). Then create links in the {builder}."), {
            functions: <span dir="ltr"><code className="font-mono">onDeepLink</code>, <code className="font-mono">handleOpenUrl</code></span>,
            builder: <Link href={`${base}/links?env=${env.type}`} className="underline">{t("link builder")}</Link>,
          })}
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="h2">{t("Custom domain")}</h2>
        <p className="text-sm text-ink-2">
          {rich(t("Links work on {host} out of the box. A dedicated link host (LeanApp's {leanappHost}, or your own such as {example}) is recommended: branded links get more taps, and Apple caches association files per host. For your own domain:"), {
            host: <code className="font-mono" dir="ltr">{defaultLinkHost()}</code>,
            leanappHost: <code className="font-mono" dir="ltr">l.leanapp.io</code>,
            example: <code className="font-mono" dir="ltr">links.example.com</code>,
          })}
        </p>
        <ol className="list-decimal space-y-1 ps-5 text-sm text-ink-2">
          <li>{rich(t("Add a DNS record: {record} (a subdomain; the apex would need A records)."), { record: <code className="font-mono" dir="ltr">links.example.com CNAME cname.vercel-dns.com.</code> })}</li>
          <li>{t("Ask LeanApp support to attach the domain to the link service. This is a manual step today: the domain must be added to LeanApp's hosting before HTTPS works.")}</li>
          <li>{rich(t("Enter it above, update the Associated Domains and intent filter host, and press {test}."), { test: <strong>{t("Test")}</strong> })}</li>
        </ol>
      </section>
    </div>
  );
}
