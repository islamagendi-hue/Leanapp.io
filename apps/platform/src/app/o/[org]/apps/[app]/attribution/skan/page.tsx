import { deleteSchemaAction, saveSchemaAction, updateSkanSettingsAction } from "@/app/actions/attribution-skan";
import { param, RANGE_LABELS } from "@/components/AnalyticsHeader";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { ATTRIBUTION_RANGES } from "@/modules/attribution/reports";
import { EXAMPLE_SCHEMA } from "@/modules/attribution/skan-schema";
import { getConversionSchema, getSkanSettings, skanBySource, skanEndpoint } from "@/modules/attribution/skan-service";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "SKAdNetwork" };

const NETWORK_LABELS: Record<string, string> = { meta: "Meta", google: "Google", snapchat: "Snap", tiktok: "TikTok", x: "X" };
const num = (n: number) => n.toLocaleString("en-US");

export default async function SkanPage(props: PageProps<"/o/[org]/apps/[app]/attribution/skan">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const env = pickEnvironment(environments, sp.env ?? "production");
  const days = (ATTRIBUTION_RANGES as readonly number[]).includes(Number(param(sp.days))) ? Number(param(sp.days)) : 30;
  const [settings, schema, rows] = await Promise.all([getSkanSettings(ctx, a.id), getConversionSchema(ctx, a.id), skanBySource(ctx, env.id, days)]);
  const manage = can(ctx.role, "attribution.manage");
  const base = `/o/${org}/apps/${app}/attribution/skan`;
  const endpoint = skanEndpoint(publicBaseUrl());

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">SKAdNetwork &amp; AdAttributionKit</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Apple&apos;s privacy-preserving install attribution for iOS. Apple sends each winning postback to the ad network and a copy to you; LeanApp verifies Apple&apos;s
            signature, stores it, and reports it per network and campaign (source identifier). Postbacks carry no user or device id, so they are never joined to users.
          </p>
        </div>
        <EnvSwitcher path={base} current={env.type} query={sp} />
      </div>

      <section className="card max-w-3xl space-y-4">
        <h2 className="h2">1. Receive postback copies</h2>
        <ol className="list-decimal space-y-2 ps-5 text-sm text-ink-2">
          <li>
            In your iOS app&apos;s Info.plist, set <code className="code">NSAdvertisingAttributionReportEndpoint</code> (SKAdNetwork) and, under <code className="code">AdAttributionKit</code>,{" "}
            <code className="code">AttributionCopyEndpoint</code> to <code className="code">{endpoint.plistValue}</code>.
          </li>
          <li>
            Apple then posts to <code className="code break-all">{endpoint.skadnetworkUrl}</code> and <code className="code break-all">{endpoint.adattributionkitUrl}</code>.
            Apple uses only the registrable domain, so if you prefer your own domain, forward those two paths there unchanged (POST body as is).
          </li>
          <li>Enter the App Store id below: postbacks are routed to this app by it. SKAdNetwork and production AdAttributionKit postbacks land in production; AdAttributionKit development-key postbacks in development.</li>
        </ol>
        {!endpoint.configured && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            This server has no SKAN_REPORT_DOMAIN set, so the domain above is assumed from the API URL. Check that {endpoint.skadnetworkUrl} reaches this deployment before
            shipping the Info.plist change.
          </p>
        )}
        <ActionForm action={updateSkanSettingsAction.bind(null, org, app)} submitLabel="Save" className="space-y-3">
          <fieldset disabled={!manage} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">App Store id</span>
              <input name="appStoreId" className="input font-mono" inputMode="numeric" defaultValue={settings.ios_app_store_id ?? ""} placeholder="1234567890" />
              <span className="help">The number in apps.apple.com/app/id<strong>1234567890</strong>.</span>
            </label>
            <label className="block sm:col-span-2"><span className="label">SKAdNetwork ids in your Info.plist (SKAdNetworkItems)</span>
              <textarea name="networkIds" className="input font-mono text-sm" rows={4} defaultValue={settings.skan_network_ids.join("\n")} placeholder={"v9wttpbfk9.skadnetwork\ncstr6suwn9.skadnetwork"} />
              <span className="help">For reference: LeanApp can&apos;t read your Info.plist. Postbacks only come from networks listed there.</span>
            </label>
          </fieldset>
        </ActionForm>
      </section>

      <section className="card max-w-3xl space-y-4">
        <h2 className="h2">2. Conversion values</h2>
        <p className="text-sm text-ink-2">
          Which in-app events and revenue set the fine value (0–63, first window) and the coarse value (low / medium / high, all three windows: 0–2 days, 3–7 days,
          8–35 days). Apps download it with their SDK key from <code className="code">GET /v1/skan/conversion-schema</code>.{" "}
          <strong>The iOS SDK doesn&apos;t apply it yet</strong> (calling <code className="code">SKAdNetwork.updatePostbackConversionValue</code> is not built), so for now
          your app has to call Apple&apos;s API itself following these rules. Values only go up within a window; a rule with <code className="code">lock</code> ends its window
          early. Revenue counts per window in the schema currency (other currencies are ignored).
        </p>
        {schema ? (
          <table className="table">
            <thead><tr><th>Window</th><th>When</th><th className="text-end">Fine</th><th>Coarse</th><th>Lock</th></tr></thead>
            <tbody>
              {schema.schema.rules.map((r, i) => (
                <tr key={i}>
                  <td className="tabular-nums">{r.window}</td>
                  <td className="font-mono text-xs">
                    {r.event ?? "any event"}
                    {(r.min_revenue !== undefined || r.max_revenue !== undefined) && ` · revenue ${r.min_revenue ?? 0}–${r.max_revenue ?? "∞"} ${schema.schema.currency}`}
                  </td>
                  <td className="text-end tabular-nums">{r.fine ?? "–"}</td>
                  <td>{r.coarse ?? "–"}</td>
                  <td>{r.lock ? "yes" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-ink-3">No schema yet: the SDK doesn&apos;t update conversion values, so postbacks arrive with null values.</p>
        )}
        {manage && (
          <>
            <ActionForm action={saveSchemaAction.bind(null, org, app)} submitLabel="Save schema" className="space-y-3">
              <label className="block"><span className="label">Schema (JSON){schema ? ` · revision ${schema.revision}` : ""}</span>
                <textarea name="schema" className="input font-mono text-xs" rows={14} defaultValue={JSON.stringify(schema?.schema ?? EXAMPLE_SCHEMA, null, 2)} />
                <span className="help">
                  Rules: <code className="code">{"{ window: 0|1|2, event?, min_revenue?, max_revenue?, fine? (window 0), coarse?, lock? }"}</code>. Applies to every environment.
                </span>
              </label>
            </ActionForm>
            {schema && <ActionForm action={deleteSchemaAction.bind(null, org, app)} submitLabel="Remove schema" buttonClass="btn-danger" className="" confirm="Stop updating conversion values?" />}
          </>
        )}
      </section>

      <section className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
          <h2 className="h2">Postbacks by network and source identifier ({env.type})</h2>
          <form method="get" className="flex items-end gap-2">
            <input type="hidden" name="env" value={env.type} />
            <select name="days" className="input" defaultValue={String(days)}>{ATTRIBUTION_RANGES.map((d) => <option key={d} value={d}>{RANGE_LABELS[d]}</option>)}</select>
            <button className="btn-secondary" type="submit">Show</button>
          </form>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 pb-5 pt-2 text-sm text-ink-3">
            No verified postbacks in {env.type} for this range.{!settings.ios_app_store_id && " Enter the App Store id above first."} Apple sends postbacks 24–48 hours (first
            window) or later after an install, only for ads signed by networks in your Info.plist.
          </p>
        ) : (
          <table className="table mt-3">
            <thead>
              <tr>
                <th>Ad network</th><th>Source id</th><th className="text-end">Postbacks</th><th className="text-end">Won</th><th className="text-end">1st / 2nd / 3rd</th>
                <th className="text-end">Avg fine</th><th className="text-end">Coarse L / M / H</th><th className="text-end">Redownloads</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.framework}:${r.ad_network_id}:${r.source_identifier}`}>
                  <td>
                    {r.network ? NETWORK_LABELS[r.network] : <span className="font-mono text-xs">{r.ad_network_id}</span>}
                    {r.framework === "adattributionkit" && <span className="pill ms-2 border-line">AdAttributionKit</span>}
                  </td>
                  <td className="font-mono text-xs">{r.source_identifier ?? "–"}</td>
                  <td className="text-end tabular-nums">{num(r.postbacks)}</td>
                  <td className="text-end tabular-nums">{num(r.wins)}</td>
                  <td className="text-end tabular-nums">{r.first} / {r.second} / {r.third}</td>
                  <td className="text-end tabular-nums">{r.fine_avg === null ? "–" : r.fine_avg.toFixed(1)}</td>
                  <td className="text-end tabular-nums">{r.coarse_low} / {r.coarse_medium} / {r.coarse_high}</td>
                  <td className="text-end tabular-nums">{num(r.redownloads)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
