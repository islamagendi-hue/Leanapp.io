import { createApiKeyAction, createSdkKeyAction, revokeApiKeyAction, revokeSdkKeyAction, rotateSdkKeyAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { API_KEY_SCOPES, listKeys, type ApiKeyScope } from "@/modules/credentials/service";
import { SDK_AVAILABILITY, testEventCurl } from "@/modules/implementation/codegen";
import { SDK_RELEASES, sdkNote, sdkQuickstarts } from "@/modules/implementation/sdks";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "SDK & API keys" };

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "never");

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "events:write": "Send events",
  "privacy:read": "Export user data, read consent and suppressions",
  "privacy:write": "Delete user data, manage suppressions",
  "management:read": "Read app, environment and tracking plan",
  "plan:write": "Add events to a draft plan",
  "analytics:read": "Read events reports",
  "users:read": "Look up users",
};

export default async function SdkPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/sdk">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "credentials.read");
  const env = await pickEnvironment(environments, sp.env);
  const keys = await listKeys(ctx, a.id);
  const sdkKeys = keys.sdkKeys.filter((k) => k.environment_id === env.id);
  const apiKeys = keys.apiKeys.filter((k) => k.environment_id === env.id);
  const active = sdkKeys.find((k) => k.status === "active" && (!k.expires_at || new Date(k.expires_at) > new Date()));
  const manage = can(ctx.role, "credentials.manage");
  const api = publicBaseUrl();
  const pk = active?.key ?? "<your public SDK key>";

  const quick = sdkQuickstarts({ key: pk, endpoint: api, currency: a.default_currency });
  const install = [
    ...quick.map((q) => ({ key: q.key, label: SDK_AVAILABILITY[q.key].label, note: sdkNote(q.key), code: q.code })),
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
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">SDK &amp; API keys</h1>
          <p className="mt-1 text-ink-2">Each environment has its own keys and its own data.</p>
        </div>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">1. Install and initialize</h2>
        <CodeTabs tabs={install} preferred="react_native" />
        <p className="text-sm text-ink-3">The SDKs are built and tested but not on npm, Maven Central, pub.dev or a tagged Swift release yet, so add them from the LeanApp repository as each snippet shows. Then open the <a className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/debugger?env=${env.type}`}>event debugger</a> and watch your first event arrive.</p>
      </section>

      <section className="card overflow-x-auto p-0" aria-label="SDK release status">
        <h2 className="h2 px-5 pt-5">SDK release status</h2>
        <table className="table mt-3">
          <thead><tr><th>SDK</th><th>Package</th><th>Status</th><th>Verified</th><th>Not built yet</th></tr></thead>
          <tbody>
            {SDK_RELEASES.map((r) => (
              <tr key={r.key}>
                <td className="font-medium">{r.label}</td>
                <td className="font-mono text-xs">{r.pkg}</td>
                <td>{r.published ? <span className="pill border-accent/40 bg-accent-soft text-xs text-accent-ink">Published</span> : <span className="pill border-warn/40 bg-warn-soft text-xs text-warn">Not published: add from the repository</span>}</td>
                <td className="text-sm text-ink-2">{r.verified}</td>
                <td className="text-sm text-ink-2">{r.gaps.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
