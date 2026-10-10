import Link from "next/link";
import { configureIntegrationAction, emailDomainAction, removeIntegrationAction, whatsappAction } from "@/app/actions/engage";
import { configureTwilioAction, verifyConnectionAction } from "@/app/actions/messaging";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { encryptionAvailable } from "@/lib/secret-box";
import { getEmailDomain, type EmailDomain } from "@/modules/messaging/email";
import { senderDomain } from "@/modules/messaging/email-content";
import { listIntegrations, type IntegrationRow } from "@/modules/messaging/integrations";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { publicBaseUrl } from "@/server/env";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang, type T } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Integrations") };
}

const NOT_LIVE = {
  push: msg("Built to the FCM HTTP v1 and APNs token-auth specifications and tested against local mocks. Not yet verified with live FCM/APNs: this changes once a real send succeeds."),
  whatsapp: msg("Built to the WhatsApp Business Cloud API (Graph API) and tested against a local mock. Not verified with the live WhatsApp API: this changes once a real send succeeds."),
  resend: msg("Tested against a local mock of the Resend API. Not yet verified with live Resend: this changes once a real send succeeds."),
  twilio: msg("Built to Twilio's Messages and Content APIs and tested against a local mock. Not verified with live Twilio: this changes once a real send succeeds."),
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
  const twilio = by("twilio");
  const t = await getT();
  const lang = await getLang();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Integrations")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">{(([a, b]) => <>{a}<strong>{t(env.type)}</strong>{b}</>)(t("Delivery channels for automations in the {env} environment. Each environment has its own credentials, so test messages never reach production users. Credentials are your own accounts', stored encrypted and never shown again.").split("{env}"))}</p>
        </div>
      </div>
      {!keyReady && (
        <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
          {t("Credentials can't be stored on this server: {key} is not configured. Nothing below can be connected until the operator sets it.", { key: "INTEGRATIONS_ENCRYPTION_KEY" })}
        </p>
      )}

      <Provider title={t("Firebase Cloud Messaging (Android, and iOS through Firebase)")} row={by("fcm")} note={t(NOT_LIVE.push)} manage={manage} org={org} app={app} t={t} lang={lang}>
        {manage && (
          <ActionForm action={configure("fcm")} submitLabel={by("fcm") ? t("Replace credentials") : t("Connect FCM")} className="space-y-3">
            <label className="block"><span className="label">{t("Service account key (JSON)")}</span><input type="file" name="serviceAccount" accept="application/json,.json" className="input py-2" /></label>
            <p className="help">{t('Firebase console → Project settings → Service accounts → Generate new private key. Needs the "Firebase Cloud Messaging API Admin" role.')}</p>
          </ActionForm>
        )}
      </Provider>

      <Provider title={t("Apple Push Notification service (iOS)")} row={by("apns")} note={t(NOT_LIVE.push)} manage={manage} org={org} app={app} t={t} lang={lang}>
        {manage && (
          <ActionForm action={configure("apns")} submitLabel={by("apns") ? t("Replace credentials") : t("Connect APNs")} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">{t("Key ID")}</span><input name="keyId" className="input font-mono" maxLength={10} required /></label>
            <label className="block"><span className="label">{t("Team ID")}</span><input name="teamId" className="input font-mono" maxLength={10} required /></label>
            <label className="block"><span className="label">{t("Bundle ID")}</span><input name="bundleId" className="input font-mono" placeholder="com.example.app" required /></label>
            <label className="block"><span className="label">{t("APNs environment")}</span>
              <select name="apnsEnvironment" className="input" defaultValue={env.type === "production" ? "production" : "sandbox"}>
                <option value="sandbox">{t("Sandbox (development builds)")}</option>
                <option value="production">{t("Production (TestFlight / App Store)")}</option>
              </select>
            </label>
            <label className="block sm:col-span-2"><span className="label">{t("Auth key (.p8)")}</span><input type="file" name="p8File" accept=".p8" className="input py-2" required /></label>
          </ActionForm>
        )}
      </Provider>

      <Provider title={t("WhatsApp (Meta WhatsApp Business Cloud API)")} row={wa} note={t(NOT_LIVE.whatsapp)} manage={manage} org={org} app={app} t={t} lang={lang}>
        <p className="text-sm text-ink-2">
          {(([a, b]) => <>{a}<strong>{t("approved template messages")}</strong>{b}</>)(t("Automations send {templates} to the phone number in a user property, in E.164 format (+9665…). Marketing messages outside the 24-hour customer service window must be templates. People who denied marketing consent, are on the WhatsApp suppression list, or reply STOP / إيقاف are skipped.").split("{templates}"))}
        </p>
        {wa && (
          <div className="space-y-2 rounded-lg bg-paper-2 px-3 py-2 text-sm">
            <p><span className="font-medium">{t("Webhook callback URL:")}</span> <code dir="ltr" className="break-all font-mono text-xs">{publicBaseUrl()}/v1/whatsapp/webhook/{wa.id}</code></p>
            <p className="help">{t("In your Meta app → WhatsApp → Configuration, paste this URL with the verify token shown when you connected, and subscribe to the {field} field. Delivery and read receipts and opt-out replies then update LeanApp.", { field: "messages" })}</p>
            {manage && (
              <div className="flex flex-wrap gap-2">
                <ActionForm action={whatsappAction.bind(null, org, app, env.id, "rotate")} submitLabel={t("New verify token")} buttonClass="btn-secondary" confirm={t("Issue a new verify token? Update it in your Meta app too.")} />
                <ActionForm action={verifyConnectionAction.bind(null, org, app, env.id, "whatsapp")} submitLabel={t("Check connection")} buttonClass="btn-secondary" />
              </div>
            )}
            <p className="help">{t("Free-form WhatsApp messages (flows) go only to people who messaged you in the last 24 hours; replies, delivery and read receipts arrive through this webhook.")} <Link className="underline" href={`/o/${org}/apps/${app}/engage/templates?env=${env.type}`}>{t("Manage templates")}</Link></p>
          </div>
        )}
        {manage && (
          <ActionForm action={configure("whatsapp")} submitLabel={wa ? t("Replace credentials") : t("Connect WhatsApp")} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">{t("Phone number ID")}</span><input name="phoneNumberId" className="input font-mono" inputMode="numeric" required /></label>
            <label className="block"><span className="label">{t("WhatsApp Business Account ID")}</span><input name="wabaId" className="input font-mono" inputMode="numeric" required /></label>
            <label className="block"><span className="label">{t("Access token (system user, permanent)")}</span><input name="accessToken" type="password" className="input font-mono" autoComplete="off" required /></label>
            <label className="block"><span className="label">{t("App secret (verifies webhook signatures)")}</span><input name="appSecret" type="password" className="input font-mono" autoComplete="off" required /></label>
            <p className="help sm:col-span-2">{t("From Meta for Developers → your app → WhatsApp → API Setup, and App settings → Basic. The token needs {a} and {b}.", { a: "whatsapp_business_messaging", b: "whatsapp_business_management" })}</p>
          </ActionForm>
        )}
        {wa && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("Message templates")}</h3>
              {manage && <ActionForm action={whatsappAction.bind(null, org, app, env.id, "sync")} submitLabel={t("Sync templates")} buttonClass="btn-secondary" />}
            </div>
            {templates.length ? (
              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead><tr><th>{t("Name")}</th><th>{t("Language")}</th><th>{t("Category")}</th><th>{t("Status")}</th><th>{t("Variables")}</th></tr></thead>
                  <tbody>
                    {templates.map((tp) => (
                      <tr key={tp.id}>
                        <td className="font-mono text-xs">{tp.name}</td><td>{tp.language}</td><td>{tp.category?.toLowerCase() ?? "—"}</td>
                        <td className={tp.status === "APPROVED" ? "text-accent-ink" : "text-ink-3"}>{tp.status.toLowerCase()}</td>
                        <td>{tp.body_params + tp.header_params}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-ink-3">{t("No templates synced yet. Create templates and get them approved in WhatsApp Manager, then sync.")}</p>}
          </div>
        )}
      </Provider>

      <Provider title={t("Twilio (SMS, MMS and WhatsApp through Twilio)")} row={twilio} note={t(NOT_LIVE.twilio)} manage={manage} org={org} app={app} t={t} lang={lang}>
        <p className="text-sm text-ink-2">{t("SMS goes to the phone number in a user property (E.164). SMS is text only; images (MMS) only to US and Canadian numbers. WhatsApp through Twilio uses Content templates approved for WhatsApp. People who reply STOP, denied marketing consent or are on the SMS / WhatsApp suppression list are skipped.")}</p>
        {twilio && (
          <div className="space-y-2 rounded-lg bg-paper-2 px-3 py-2 text-sm">
            <p><span className="font-medium">{t("Callback URL:")}</span> <code dir="ltr" className="break-all font-mono text-xs">{publicBaseUrl()}/v1/twilio/webhook/{twilio.id}</code></p>
            <p className="help">{t("LeanApp sets it as the status callback on every message. Also set it as \"A message comes in\" on your Twilio number or Messaging Service (HTTP POST) to receive replies and STOP. Twilio signs each request with your auth token.")}</p>
            {manage && <ActionForm action={verifyConnectionAction.bind(null, org, app, env.id, "twilio")} submitLabel={t("Check connection")} buttonClass="btn-secondary" />}
          </div>
        )}
        {manage && (
          <ActionForm action={configureTwilioAction.bind(null, org, app, env.id)} submitLabel={twilio ? t("Replace credentials") : t("Connect Twilio")} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">{t("Account SID")}</span><input name="accountSid" className="input font-mono" placeholder="AC…" required /></label>
            <label className="block"><span className="label">{t("Auth token")}</span><input name="authToken" type="password" className="input font-mono" autoComplete="off" required /></label>
            <label className="block"><span className="label">{t("Messaging Service SID (optional)")}</span><input name="messagingServiceSid" className="input font-mono" placeholder="MG…" /></label>
            <label className="block"><span className="label">{t("SMS sender number (if no Messaging Service)")}</span><input name="fromNumber" className="input font-mono" placeholder="+14155550100" dir="ltr" /></label>
            <label className="block"><span className="label">{t("WhatsApp sender (optional)")}</span><input name="whatsappFrom" className="input font-mono" placeholder="+14155550100" dir="ltr" /></label>
            <p className="help sm:col-span-2">{t("From the Twilio Console → Account info. The auth token also verifies Twilio's callback signatures.")}</p>
          </ActionForm>
        )}
      </Provider>

      <Provider title={t("Email to your users (Resend)")} row={resend} note={t(NOT_LIVE.resend)} manage={manage} org={org} app={app} t={t} lang={lang}>
        <p className="text-sm text-ink-2">{(([a, b]) => <>{a}<strong>{t("your own")}</strong>{b}</>)(t("Sends from {own} Resend account and domain; LeanApp's email account is never used for your users. Every email has an unsubscribe link and one-click List-Unsubscribe headers. People who unsubscribed, denied marketing consent or are on the email suppression list are skipped.").split("{own}"))}</p>
        {manage && (
          <ActionForm action={configure("resend")} submitLabel={resend ? t("Replace credentials") : t("Connect Resend")} className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="label">{t("API key")}</span><input name="apiKey" type="password" className="input font-mono" autoComplete="off" required /></label>
            <label className="block"><span className="label">{t("From")}</span><input name="from" className="input" placeholder="My App <hello@mail.myapp.com>" required /></label>
          </ActionForm>
        )}
        {resend && <SendingDomain domain={domain} from={resend.config.from} manage={manage} org={org} app={app} envId={env.id} t={t} lang={lang} />}
      </Provider>
    </div>
  );
}

function SendingDomain({ domain, from, manage, org, app, envId, t, lang }: { domain: EmailDomain | null; from?: string; manage: boolean; org: string; app: string; envId: string; t: T; lang: Lang }) {
  const act = (op: "add" | "check" | "verify" | "remove") => emailDomainAction.bind(null, org, app, envId, op);
  const mismatch = domain && from && senderDomain(from) !== domain.name;
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <h3 className="font-medium">{t("Sending domain")}</h3>
      {!domain ? (
        manage ? (
          <ActionForm action={act("add")} submitLabel={t("Add domain to Resend")} className="flex flex-wrap items-end gap-3">
            <label className="block min-w-60 flex-1"><span className="label">{t("Domain")}</span><input name="domain" className="input font-mono" placeholder="mail.myapp.com" required /></label>
          </ActionForm>
        ) : <p className="text-sm text-ink-3">{t("No sending domain set up.")}</p>
      ) : (
        <>
          <p className="text-sm">
            <code className="font-mono">{domain.name}</code> ·{" "}
            <span className={domain.status === "verified" ? "text-accent-ink" : "text-alert"}>{t(domain.status.replace(/_/g, " "))}</span>
            <span className="text-ink-3"> · {t("checked {date}", { date: new Date(domain.last_checked_at).toLocaleString(dateLocale(lang)) })}</span>
          </p>
          {mismatch && <p className="text-sm text-alert">{t("The From address ({from}) isn't on {domain}. Resend only sends from verified domains.", { from: from ?? "", domain: domain.name })}</p>}
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead><tr><th>{t("Type")}</th><th>{t("Name")}</th><th>{t("Value")}</th><th>{t("Priority")}</th><th>{t("Status")}</th></tr></thead>
              <tbody>
                {domain.records.map((r, i) => (
                  <tr key={i}>
                    <td>{r.type}</td><td className="font-mono text-xs">{r.name}</td>
                    <td className="max-w-md break-all font-mono text-xs">{r.value}</td><td>{r.priority ?? ""}</td><td>{r.status ? t(r.status.replace(/_/g, " ")) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="help">{t("Add these records at your DNS provider, then verify. They come from Resend's API for your account.")}</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <ActionForm action={act("verify")} submitLabel={t("Verify DNS records")} />
              <ActionForm action={act("check")} submitLabel={t("Refresh status")} buttonClass="btn-secondary" />
              <ActionForm action={act("remove")} submitLabel={t("Remove")} buttonClass="btn-danger" confirm={t("Remove the domain here? It stays in your Resend account.")} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Provider({ title, row, note, manage, org, app, t, lang, children }: { title: string; row?: IntegrationRow; note: string; manage: boolean; org: string; app: string; t: T; lang: Lang; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="h2">{title}</h2>
          <p className="text-sm">
            {row ? (
              <span className={row.last_error ? "text-alert" : "text-accent-ink"}>
                {t("Connected")}{Object.entries(row.config).length ? ` · ${Object.entries(row.config).map(([k, v]) => `${k}: ${v}`).join(" · ")}` : ""}
              </span>
            ) : <span className="text-ink-3">{t("Not connected: these messages are logged as failed, never as sent.")}</span>}
          </p>
          {row && <p className="text-xs text-ink-3">{t("Last used {date}", { date: fmtDate(row.last_used_at, lang) })}{row.last_error ? ` · ${t("last error: {error}", { error: row.last_error })}` : ""}</p>}
          <p className="mt-1 text-xs text-ink-3">{row?.live_verified_at ? t("Verified with the live API: the first real send succeeded {date}.", { date: fmtDate(row.live_verified_at, lang) }) : note}</p>
        </div>
        {row && manage && <ActionForm action={removeIntegrationAction.bind(null, org, app, row.id)} submitLabel={t("Disconnect")} buttonClass="btn-danger" className="space-y-2" confirm={t("Disconnect and delete these credentials?")} />}
      </div>
      {children}
    </section>
  );
}
