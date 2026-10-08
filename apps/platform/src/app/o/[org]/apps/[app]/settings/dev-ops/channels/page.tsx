import { configureIntegrationAction, emailDomainAction, removeIntegrationAction, whatsappAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { encryptionAvailable } from "@/lib/secret-box";
import { getEmailDomain, type EmailDomain } from "@/modules/messaging/email";
import { senderDomain } from "@/modules/messaging/email-content";
import { listIntegrations, type IntegrationRow } from "@/modules/messaging/integrations";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Integrations" };

const NOT_LIVE = {
  push: "Built to the FCM HTTP v1 and APNs token-auth specifications and tested against local mocks. Not yet verified with live FCM/APNs: this changes once a real send succeeds.",
  whatsapp: "Built to the WhatsApp Business Cloud API (Graph API) and tested against a local mock. Not verified with the live WhatsApp API: this changes once a real send succeeds.",
  resend: "Tested against a local mock of the Resend API. Not yet verified with live Resend: this changes once a real send succeeds.",
};

export default async function IntegrationsPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/channels">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "integrations.read");
  const env = await pickEnvironment(environments, sp.env);
  const [rows, domain, templates] = await Promise.all([
    listIntegrations(ctx, env.id),
    getEmailDomain(ctx, env.id),
    can(ctx.role, "automations.read") ? listTemplates(ctx, env.id) : Promise.resolve([]),
  ]);
  const manage = can(ctx.role, "integrations.manage");
  const keyReady = encryptionAvailable();
  const by = (p: string) => rows.find((r) => r.provider === p);
  const configure = (p: "fcm" | "apns" | "resend" | "whatsapp") => configureIntegrationAction.bind(null, org, app, env.id, p);
  const wa = by("whatsapp");
  const resend = by("resend");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Integrations</h1>
          <p className="mt-1 max-w-2xl text-ink-2">Delivery channels for automations in the <strong>{env.type}</strong> environment. Each environment has its own credentials, so test messages never reach production users. Credentials are your own accounts&apos;, stored encrypted and never shown again.</p>
        </div>
      </div>
      {!keyReady && (
        <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
          Credentials can&apos;t be stored on this server: <code>INTEGRATIONS_ENCRYPTION_KEY</code> is not configured. Nothing below can be connected until the operator sets it.
        </p>
      )}

      <Provider title="Firebase Cloud Messaging (Android, and iOS through Firebase)" row={by("fcm")} note={NOT_LIVE.push} manage={manage} org={org} app={app}>
        {manage && (
          <ActionForm action={configure("fcm")} submitLabel={by("fcm") ? "Replace credentials" : "Connect FCM"} className="space-y-3">
            <label className="block"><span className="label">Service account key (JSON)</span><input type="file" name="serviceAccount" accept="application/json,.json" className="input py-2" /></label>
            <p className="help">Firebase console → Project settings → Service accounts → Generate new private key. Needs the &quot;Firebase Cloud Messaging API Admin&quot; role.</p>
          </ActionForm>
        )}
      </Provider>

      <Provider title="Apple Push Notification service (iOS)" row={by("apns")} note={NOT_LIVE.push} manage={manage} org={org} app={app}>
        {manage && (
          <ActionForm action={configure("apns")} submitLabel={by("apns") ? "Replace credentials" : "Connect APNs"} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">Key ID</span><input name="keyId" className="input font-mono" maxLength={10} required /></label>
            <label className="block"><span className="label">Team ID</span><input name="teamId" className="input font-mono" maxLength={10} required /></label>
            <label className="block"><span className="label">Bundle ID</span><input name="bundleId" className="input font-mono" placeholder="com.example.app" required /></label>
            <label className="block"><span className="label">APNs environment</span>
              <select name="apnsEnvironment" className="input" defaultValue={env.type === "production" ? "production" : "sandbox"}>
                <option value="sandbox">Sandbox (development builds)</option>
                <option value="production">Production (TestFlight / App Store)</option>
              </select>
            </label>
            <label className="block sm:col-span-2"><span className="label">Auth key (.p8)</span><input type="file" name="p8File" accept=".p8" className="input py-2" required /></label>
          </ActionForm>
        )}
      </Provider>

      <Provider title="WhatsApp (Meta WhatsApp Business Cloud API)" row={wa} note={NOT_LIVE.whatsapp} manage={manage} org={org} app={app}>
        <p className="text-sm text-ink-2">
          Automations send <strong>approved template messages</strong> to the phone number in a user property, in E.164 format (+9665…). Marketing messages outside the 24-hour customer service window must be templates. People who denied marketing consent, are on the WhatsApp suppression list, or reply STOP / إيقاف are skipped.
        </p>
        {wa && (
          <div className="space-y-2 rounded-lg bg-paper-2 px-3 py-2 text-sm">
            <p><span className="font-medium">Webhook callback URL:</span> <code className="break-all font-mono text-xs">{publicBaseUrl()}/v1/whatsapp/webhook/{wa.id}</code></p>
            <p className="help">In your Meta app → WhatsApp → Configuration, paste this URL with the verify token shown when you connected, and subscribe to the <code>messages</code> field. Delivery and read receipts and opt-out replies then update LeanApp.</p>
            {manage && <ActionForm action={whatsappAction.bind(null, org, app, env.id, "rotate")} submitLabel="New verify token" buttonClass="btn-secondary" confirm="Issue a new verify token? Update it in your Meta app too." />}
          </div>
        )}
        {manage && (
          <ActionForm action={configure("whatsapp")} submitLabel={wa ? "Replace credentials" : "Connect WhatsApp"} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">Phone number ID</span><input name="phoneNumberId" className="input font-mono" inputMode="numeric" required /></label>
            <label className="block"><span className="label">WhatsApp Business Account ID</span><input name="wabaId" className="input font-mono" inputMode="numeric" required /></label>
            <label className="block"><span className="label">Access token (system user, permanent)</span><input name="accessToken" type="password" className="input font-mono" autoComplete="off" required /></label>
            <label className="block"><span className="label">App secret (verifies webhook signatures)</span><input name="appSecret" type="password" className="input font-mono" autoComplete="off" required /></label>
            <p className="help sm:col-span-2">From Meta for Developers → your app → WhatsApp → API Setup, and App settings → Basic. The token needs <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.</p>
          </ActionForm>
        )}
        {wa && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">Message templates</h3>
              {manage && <ActionForm action={whatsappAction.bind(null, org, app, env.id, "sync")} submitLabel="Sync templates" buttonClass="btn-secondary" />}
            </div>
            {templates.length ? (
              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead><tr><th>Name</th><th>Language</th><th>Category</th><th>Status</th><th>Variables</th></tr></thead>
                  <tbody>
                    {templates.map((t) => (
                      <tr key={t.id}>
                        <td className="font-mono text-xs">{t.name}</td><td>{t.language}</td><td>{t.category?.toLowerCase() ?? "—"}</td>
                        <td className={t.status === "APPROVED" ? "text-accent-ink" : "text-ink-3"}>{t.status.toLowerCase()}</td>
                        <td>{t.body_params + t.header_params}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-ink-3">No templates synced yet. Create templates and get them approved in WhatsApp Manager, then sync.</p>}
          </div>
        )}
      </Provider>

      <Provider title="Email to your users (Resend)" row={resend} note={NOT_LIVE.resend} manage={manage} org={org} app={app}>
        <p className="text-sm text-ink-2">Sends from <strong>your own</strong> Resend account and domain; LeanApp&apos;s email account is never used for your users. Every email has an unsubscribe link and one-click List-Unsubscribe headers. People who unsubscribed, denied marketing consent or are on the email suppression list are skipped.</p>
        {manage && (
          <ActionForm action={configure("resend")} submitLabel={resend ? "Replace credentials" : "Connect Resend"} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">API key</span><input name="apiKey" type="password" className="input font-mono" autoComplete="off" required /></label>
            <label className="block"><span className="label">From</span><input name="from" className="input" placeholder="My App <hello@mail.myapp.com>" required /></label>
          </ActionForm>
        )}
        {resend && <SendingDomain domain={domain} from={resend.config.from} manage={manage} org={org} app={app} envId={env.id} />}
      </Provider>
    </div>
  );
}

function SendingDomain({ domain, from, manage, org, app, envId }: { domain: EmailDomain | null; from?: string; manage: boolean; org: string; app: string; envId: string }) {
  const act = (op: "add" | "check" | "verify" | "remove") => emailDomainAction.bind(null, org, app, envId, op);
  const mismatch = domain && from && senderDomain(from) !== domain.name;
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <h3 className="font-medium">Sending domain</h3>
      {!domain ? (
        manage ? (
          <ActionForm action={act("add")} submitLabel="Add domain to Resend" className="flex flex-wrap items-end gap-3">
            <label className="block min-w-60 flex-1"><span className="label">Domain</span><input name="domain" className="input font-mono" placeholder="mail.myapp.com" required /></label>
          </ActionForm>
        ) : <p className="text-sm text-ink-3">No sending domain set up.</p>
      ) : (
        <>
          <p className="text-sm">
            <code className="font-mono">{domain.name}</code> ·{" "}
            <span className={domain.status === "verified" ? "text-accent-ink" : "text-alert"}>{domain.status.replace(/_/g, " ")}</span>
            <span className="text-ink-3"> · checked {new Date(domain.last_checked_at).toLocaleString("en-GB")}</span>
          </p>
          {mismatch && <p className="text-sm text-alert">The From address ({from}) isn&apos;t on {domain.name}. Resend only sends from verified domains.</p>}
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Priority</th><th>Status</th></tr></thead>
              <tbody>
                {domain.records.map((r, i) => (
                  <tr key={i}>
                    <td>{r.type}</td><td className="font-mono text-xs">{r.name}</td>
                    <td className="max-w-md break-all font-mono text-xs">{r.value}</td><td>{r.priority ?? ""}</td><td>{r.status?.replace(/_/g, " ") ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="help">Add these records at your DNS provider, then verify. They come from Resend&apos;s API for your account.</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <ActionForm action={act("verify")} submitLabel="Verify DNS records" />
              <ActionForm action={act("check")} submitLabel="Refresh status" buttonClass="btn-secondary" />
              <ActionForm action={act("remove")} submitLabel="Remove" buttonClass="btn-danger" confirm="Remove the domain here? It stays in your Resend account." />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Provider({ title, row, note, manage, org, app, children }: { title: string; row?: IntegrationRow; note: string; manage: boolean; org: string; app: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="h2">{title}</h2>
          <p className="text-sm">
            {row ? (
              <span className={row.last_error ? "text-alert" : "text-accent-ink"}>
                Connected{Object.entries(row.config).length ? ` · ${Object.entries(row.config).map(([k, v]) => `${k}: ${v}`).join(" · ")}` : ""}
              </span>
            ) : <span className="text-ink-3">Not connected: these messages are logged as failed, never as sent.</span>}
          </p>
          {row && <p className="text-xs text-ink-3">Last used {fmtDate(row.last_used_at)}{row.last_error ? ` · last error: ${row.last_error}` : ""}</p>}
          <p className="mt-1 text-xs text-ink-3">{row?.live_verified_at ? `Verified with the live API: the first real send succeeded ${fmtDate(row.live_verified_at)}.` : note}</p>
        </div>
        {row && manage && <ActionForm action={removeIntegrationAction.bind(null, org, app, row.id)} submitLabel="Disconnect" buttonClass="btn-danger" className="space-y-2" confirm="Disconnect and delete these credentials?" />}
      </div>
      {children}
    </section>
  );
}
