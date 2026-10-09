import Link from "next/link";
import { createApiKeyAction, createSdkKeyAction, revokeApiKeyAction, revokeSdkKeyAction, rotateSdkKeyAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { API_KEY_SCOPES, listKeys, type ApiKeyScope } from "@/modules/credentials/service";
import { SDK_AVAILABILITY, testEventCurl } from "@/modules/implementation/codegen";
import { SDK_RELEASES, sdkNote, sdkQuickstarts } from "@/modules/implementation/sdks";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { localizeText } from "@/modules/implementation/localize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("SDK & API keys") };
}

const ENV_ORDER = { production: 0, staging: 1, development: 2 } as const;
const fmtWith = (lang: Lang, never: string) => (d: Date | null) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : never);

const SCOPE_LABEL: Record<ApiKeyScope, string> = {
  "events:write": msg("Send events"),
  "privacy:read": msg("Export user data, read consent and suppressions"),
  "privacy:write": msg("Delete user data, manage suppressions"),
  "management:read": msg("Read app, environment and tracking plan"),
  "plan:write": msg("Add events to a draft plan"),
  "analytics:read": msg("Read events reports"),
  "users:read": msg("Look up users"),
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
  const t = await getT();
  const lang = await getLang();
  const fmt = fmtWith(lang, t("never"));

  const quick = sdkQuickstarts({ key: pk, endpoint: api, currency: a.default_currency });
  const install = [
    ...quick.map((q) => ({ key: q.key, label: t(SDK_AVAILABILITY[q.key].label), note: localizeText(sdkNote(q.key), t, lang), code: q.code })),
    {
      key: "backend",
      label: t(SDK_AVAILABILITY.backend.label),
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
      label: t("Send a test event now"),
      code: testEventCurl(api, pk),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("SDK & API keys")}</h1>
          <p className="mt-1 text-ink-2">{t("Each environment has its own keys and its own data.")} <Link className="underline" href={`/o/${org}/settings/api-keys`}>{t("All projects' keys")}</Link></p>
        </div>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label={t("Environment")}>
        {[...environments].sort((x, y) => ENV_ORDER[x.type] - ENV_ORDER[y.type]).map((e) => (
          <Link key={e.id} href={`?env=${e.type}`} aria-current={e.id === env.id ? "page" : undefined}
            className={`pill ${e.id === env.id ? "border-ink bg-ink text-paper" : "border-line hover:border-line-strong"}`}>
            {e.name}{e.status === "disabled" ? ` ${t("(paused)")}` : ""}
          </Link>
        ))}
      </nav>

      <section className="card space-y-3">
        <h2 className="h2">{t("1. Install and initialize")}</h2>
        <CodeTabs tabs={install} preferred="react_native" />
        <p className="text-sm text-ink-3">{(([x, y]) => <>{x}<a className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/debugger?env=${env.type}`}>{t("event debugger")}</a>{y}</>)(t("The SDKs are built and tested but not on npm, Maven Central, pub.dev or a tagged Swift release yet, so add them from the LeanApp repository as each snippet shows. Then open the {debugger} and watch your first event arrive.").split("{debugger}"))}</p>
      </section>

      <section className="card overflow-x-auto p-0" aria-label={t("SDK release status")}>
        <h2 className="h2 px-5 pt-5">{t("SDK release status")}</h2>
        <table className="table mt-3">
          <thead><tr><th>SDK</th><th>{t("Package")}</th><th>{t("Status")}</th><th>{t("Verified")}</th><th>{t("Not built yet")}</th></tr></thead>
          <tbody>
            {SDK_RELEASES.map((r) => (
              <tr key={r.key}>
                <td className="font-medium">{r.label}</td>
                <td className="font-mono text-xs">{r.pkg}</td>
                <td>{r.published ? <span className="pill border-accent/40 bg-accent-soft text-xs text-accent-ink">{t("Published")}</span> : <span className="pill border-warn/40 bg-warn-soft text-xs text-warn">{t("Not published: add from the repository")}</span>}</td>
                <td className="text-sm text-ink-2">{t(r.verified)}</td>
                <td className="text-sm text-ink-2">{r.gaps.map((g) => t(g)).join(lang === "ar" ? "؛ " : "; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">{t("Public SDK keys")} <span className="text-sm font-normal text-ink-3">{t("safe to embed in apps; can only send events")}</span></h2>
          {manage && <ActionForm action={createSdkKeyAction.bind(null, org, app, env.id)} submitLabel={t("Add key")} buttonClass="btn-secondary" className="contents" />}
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>{t("Key")}</th><th>{t("Status")}</th><th>{t("Last used")}</th><th>{t("Expires")}</th><th /></tr></thead>
            <tbody>
              {sdkKeys.map((k) => {
                const expired = k.expires_at && new Date(k.expires_at) <= new Date();
                return (
                  <tr key={k.id}>
                    <td className="font-mono text-xs break-all">{k.key}</td>
                    <td>{k.status === "revoked" ? t("revoked") : expired ? t("expired") : k.expires_at ? t("rotating out") : t("active")}</td>
                    <td className="text-ink-3">{fmt(k.last_used_at)}</td>
                    <td className="text-ink-3">{k.expires_at ? fmt(k.expires_at) : "–"}</td>
                    <td className="space-y-2">
                      {manage && k.status === "active" && !expired && (
                        <div className="flex flex-wrap gap-2">
                          <ActionForm action={rotateSdkKeyAction.bind(null, org, app, k.id)} submitLabel={t("Rotate")} buttonClass="btn-secondary" className="flex items-center gap-2">
                            <select name="graceHours" className="input min-h-9 w-auto text-xs" defaultValue="72" aria-label={t("Grace period")}>
                              <option value="0">{t("no grace")}</option><option value="24">{t("24h grace")}</option><option value="72">{t("72h grace")}</option><option value="720">{t("30d grace")}</option>
                            </select>
                          </ActionForm>
                          <ActionForm action={revokeSdkKeyAction.bind(null, org, app, k.id)} submitLabel={t("Revoke")} buttonClass="btn-danger" className="contents" confirm={t("Revoke this key now? Apps using it will stop sending events.")} />
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
        <h2 className="h2">{t("Secret API keys")} <span className="text-sm font-normal text-ink-3">{t("server-side only; for backend events, privacy requests and the management API")}</span></h2>
        {apiKeys.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Key")}</th><th>{t("Label")}</th><th>{t("Permissions")}</th><th>{t("Status")}</th><th>{t("Last used")}</th><th>{t("Expires")}</th><th /></tr></thead>
              <tbody>
                {apiKeys.map((k) => (
                  <tr key={k.id}>
                    <td className="font-mono text-xs">{k.key_prefix}…</td>
                    <td>{k.label ?? ""}</td>
                    <td className="font-mono text-xs">{k.scopes.join(", ")}</td>
                    <td>{t(k.status)}</td>
                    <td className="text-ink-3">{fmt(k.last_used_at)}</td>
                    <td className="text-ink-3">{k.expires_at ? fmt(k.expires_at) : t("never")}</td>
                    <td>{manage && k.status === "active" && <ActionForm action={revokeApiKeyAction.bind(null, org, app, k.id)} submitLabel={t("Revoke")} buttonClass="btn-danger" className="contents" confirm={t("Revoke this secret key?")} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {manage && (
          <ActionForm action={createApiKeyAction.bind(null, org, app, env.id)} submitLabel={t("Create secret key")} buttonClass="btn-secondary" className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="label">{t("Label")}</label>
              <input className="input" id="label" name="label" placeholder="payments-service" />
            </div>
            <div>
              <label className="label" htmlFor="expiresInDays">{t("Expires")}</label>
              <select className="input" id="expiresInDays" name="expiresInDays" defaultValue="">
                <option value="">{t("Never")}</option><option value="30">{t("30 days")}</option><option value="90">{t("90 days")}</option><option value="365">{t("1 year")}</option>
              </select>
            </div>
            <fieldset className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1">
              <legend className="label">{t("Permissions")}</legend>
              {API_KEY_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="scopes" value={s} defaultChecked={s === "events:write"} /> {t(SCOPE_LABEL[s])}
                </label>
              ))}
            </fieldset>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
