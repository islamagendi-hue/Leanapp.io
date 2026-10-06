import { createApiKeyAction, createSdkKeyAction, revokeApiKeyAction, revokeSdkKeyAction, rotateSdkKeyAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { API_KEY_SCOPES, listKeys, type ApiKeyScope } from "@/modules/credentials/service";
import { SDK_AVAILABILITY, testEventCurl } from "@/modules/implementation/codegen";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "SDK & API keys" };

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "never");

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "events:write": "Send events",
  "privacy:read": "Export user data",
  "privacy:write": "Delete user data",
  "management:read": "Read app, environment and tracking plan",
  "plan:write": "Add events to a draft plan",
  "analytics:read": "Read events reports",
  "users:read": "Look up users",
};

export default async function SdkPage(props: PageProps<"/o/[org]/apps/[app]/developers/sdk">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "credentials.read");
  const env = pickEnvironment(environments, sp.env);
  const keys = await listKeys(ctx, a.id);
  const sdkKeys = keys.sdkKeys.filter((k) => k.environment_id === env.id);
  const apiKeys = keys.apiKeys.filter((k) => k.environment_id === env.id);
  const active = sdkKeys.find((k) => k.status === "active" && (!k.expires_at || new Date(k.expires_at) > new Date()));
  const manage = can(ctx.role, "credentials.manage");
  const api = publicBaseUrl();
  const pk = active?.key ?? "<your public SDK key>";

  const install = [
    {
      key: "react_native",
      label: SDK_AVAILABILITY.react_native.label,
      code: `npm install @leanapp/analytics

import { Analytics } from "@leanapp/analytics";

Analytics.initialize({
  apiKey: "${pk}",
  endpoint: "${api}",
  // React Native: pass an AsyncStorage-backed adapter for offline persistence
  // storage: asyncStorageAdapter(AsyncStorage),
});

Analytics.screen("Home");
Analytics.track("product_viewed", { product_id: "123", price: 299, currency: "${a.default_currency}" });
Analytics.identify("user_123", { plan: "premium" });`,
    },
    {
      key: "backend",
      label: SDK_AVAILABILITY.backend.label,
      code: `# Server-side events use a SECRET key (create one below). Never ship it in an app.
curl -X POST ${api}/v1/events \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"event_name":"purchase_completed","event_id":"txn_1001","user_id":"user_123",
       "properties":{"transaction_id":"txn_1001","revenue":549,"currency":"${a.default_currency}"}}'`,
    },
    {
      key: "test",
      label: "Send a test event now",
      code: testEventCurl(api, pk),
    },
    { key: "kotlin", label: SDK_AVAILABILITY.kotlin.label, note: SDK_AVAILABILITY.kotlin.note, code: `// Target API (SDK not published yet)\nAnalytics.initialize(context, apiKey = "${pk}")\nAnalytics.track("product_viewed", mapOf("product_id" to "123"))` },
    { key: "swift", label: SDK_AVAILABILITY.swift.label, note: SDK_AVAILABILITY.swift.note, code: `// Target API (SDK not published yet)\nAnalytics.initialize(apiKey: "${pk}")\nAnalytics.track("product_viewed", properties: ["product_id": "123"])` },
    { key: "flutter", label: SDK_AVAILABILITY.flutter.label, note: SDK_AVAILABILITY.flutter.note, code: `// Target API (SDK not published yet)\nawait Analytics.initialize(apiKey: '${pk}');\nAnalytics.track('product_viewed', {'product_id': '123'});` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">SDK &amp; API keys</h1>
          <p className="mt-1 text-ink-2">Each environment has its own keys and its own data.</p>
        </div>
        <EnvSwitcher path={`/o/${org}/apps/${app}/developers/sdk`} current={env.type} />
      </div>

      <section className="card space-y-3">
        <h2 className="h2">1. Install and initialize</h2>
        <CodeTabs tabs={install} preferred="react_native" />
        <p className="text-sm text-ink-3">Then open the <a className="underline" href={`/o/${org}/apps/${app}/developers/debugger?env=${env.type}`}>event debugger</a> and watch your first event arrive.</p>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Public SDK keys <span className="text-sm font-normal text-ink-3">safe to embed in apps; can only send events</span></h2>
          {manage && <ActionForm action={createSdkKeyAction.bind(null, org, app, env.id)} submitLabel="Add key" buttonClass="btn-secondary" className="contents" />}
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Key</th><th>Status</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {sdkKeys.map((k) => {
                const expired = k.expires_at && new Date(k.expires_at) <= new Date();
                return (
                  <tr key={k.id}>
                    <td className="font-mono text-xs break-all">{k.key}</td>
                    <td>{k.status === "revoked" ? "revoked" : expired ? "expired" : k.expires_at ? "rotating out" : "active"}</td>
                    <td className="text-ink-3">{fmt(k.last_used_at)}</td>
                    <td className="text-ink-3">{k.expires_at ? fmt(k.expires_at) : "–"}</td>
                    <td className="space-y-2">
                      {manage && k.status === "active" && !expired && (
                        <div className="flex flex-wrap gap-2">
                          <ActionForm action={rotateSdkKeyAction.bind(null, org, app, k.id)} submitLabel="Rotate" buttonClass="btn-secondary" className="flex items-center gap-2">
                            <select name="graceHours" className="input min-h-9 w-auto text-xs" defaultValue="72" aria-label="Grace period">
                              <option value="0">no grace</option><option value="24">24h grace</option><option value="72">72h grace</option><option value="720">30d grace</option>
                            </select>
                          </ActionForm>
                          <ActionForm action={revokeSdkKeyAction.bind(null, org, app, k.id)} submitLabel="Revoke" buttonClass="btn-danger" className="contents" confirm="Revoke this key now? Apps using it will stop sending events." />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="h2">Secret API keys <span className="text-sm font-normal text-ink-3">server-side only; for backend events, privacy requests and the management API</span></h2>
        {apiKeys.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Key</th><th>Label</th><th>Permissions</th><th>Status</th><th>Last used</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {apiKeys.map((k) => (
                  <tr key={k.id}>
                    <td className="font-mono text-xs">{k.key_prefix}…</td>
                    <td>{k.label ?? ""}</td>
                    <td className="font-mono text-xs">{k.scopes.join(", ")}</td>
                    <td>{k.status}</td>
                    <td className="text-ink-3">{fmt(k.last_used_at)}</td>
                    <td className="text-ink-3">{k.expires_at ? fmt(k.expires_at) : "never"}</td>
                    <td>{manage && k.status === "active" && <ActionForm action={revokeApiKeyAction.bind(null, org, app, k.id)} submitLabel="Revoke" buttonClass="btn-danger" className="contents" confirm="Revoke this secret key?" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {manage && (
          <ActionForm action={createApiKeyAction.bind(null, org, app, env.id)} submitLabel="Create secret key" buttonClass="btn-secondary" className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="label">Label</label>
              <input className="input" id="label" name="label" placeholder="payments-service" />
            </div>
            <div>
              <label className="label" htmlFor="expiresInDays">Expires</label>
              <select className="input" id="expiresInDays" name="expiresInDays" defaultValue="">
                <option value="">Never</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option>
              </select>
            </div>
            <fieldset className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="label">Permissions</legend>
              {API_KEY_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="scopes" value={s} defaultChecked={s === "events:write"} /> {SCOPE_LABEL[s]}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
