import "server-only";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { syncScope, type SyncScope } from "@/modules/messaging/template-store";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { decryptSecret } from "@/lib/secret-box";
import { log } from "@/lib/log";
import { recordUnsubscribe } from "@/modules/messaging/consent";
import { recordInbound, senderHash } from "@/modules/messaging/inbound";
import { integrationSecret, markIntegration, sha256, type WhatsAppCredentials } from "@/modules/messaging/integrations";
import { upsertTemplates } from "@/modules/messaging/template-store";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { deploymentOf } from "@/server/config";
import {
  DEFAULT_GRAPH_VERSION, explainGraphError, GRAPH_HOST, graphError, isOptOut, messagesUrl, OPT_OUT_ERROR_CODES, parseWebhook, phoneNumberUrl,
  sessionMessageBody, templateCreateBody, templateCreateUrl, templateDeleteUrl, templateMessageBody, templatesUrl, templateVariables, verifyHubSignature,
  type SessionSend, type TemplateComponent, type TemplateDraft, type TemplateSend,
} from "./messages";

/**
 * Meta WhatsApp Business Cloud API adapter: connection check, template
 * discovery (sync), creation, submission and deletion, sending approved
 * templates and free-form (session) messages, and the webhook for delivery
 * statuses, inbound messages and opt-outs. Credentials are the customer's own
 * (per environment, encrypted; see messaging/integrations).
 *
 * WHATSAPP_API_BASE_URL points the Graph API at a local mock, only outside
 * deployments. A send to the real Graph API that succeeds marks the
 * integration as verified live; until then the UI says it is not verified.
 */
const local = () => deploymentOf(process.env) === "local";
export function graphBase(): string {
  return (local() && process.env.WHATSAPP_API_BASE_URL) || GRAPH_HOST;
}
const graphVersion = () => (/^v\d{1,2}\.\d$/.test(process.env.WHATSAPP_GRAPH_VERSION ?? "") ? process.env.WHATSAPP_GRAPH_VERSION! : DEFAULT_GRAPH_VERSION);
export const isLiveGraph = () => graphBase() === GRAPH_HOST;

/** Hash stored on the notification so an inbound reply can be matched to the person without keeping the number. */
export const recipientHash = (environmentId: string, waId: string) => senderHash(environmentId, waId);

/** "WhatsApp 190: … (what to do)" from a Graph API error response. */
function graphFailure(status: number, text: string): { code: number | null; message: string } {
  const e = graphError(status, text);
  const hint = explainGraphError(e.code);
  return { code: e.code, message: `${e.message}${hint ? ` (${hint})` : ""}` };
}

async function credsOf(db: Db, environmentId: string): Promise<{ id: string; creds: WhatsAppCredentials }> {
  const row = await integrationSecret(db, environmentId, "whatsapp");
  if (!row) throw new NotFoundError("WhatsApp integration");
  const w = JSON.parse(row.secret) as { accessToken: string; appSecret: string };
  return { id: row.id, creds: { phoneNumberId: row.config.phone_number_id, wabaId: row.config.waba_id, accessToken: w.accessToken, appSecret: w.appSecret } };
}

const auth = (c: WhatsAppCredentials) => ({ Authorization: `Bearer ${c.accessToken}` });

// ── Connection ──────────────────────────────────────────────────────────────
export interface PhoneNumberInfo {
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
}

/** GET the phone number with the stored token: proves the token and phone number ID work, and reports the number's name and quality. */
export async function verifyWhatsApp(creds: WhatsAppCredentials): Promise<{ ok: boolean; detail: string; info: PhoneNumberInfo; live: boolean }> {
  const live = isLiveGraph();
  try {
    const res = await fetch(phoneNumberUrl(graphBase(), graphVersion(), creds.phoneNumberId), { headers: auth(creds), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `WhatsApp ${graphFailure(res.status, text).message}`, info: {}, live };
    const info = JSON.parse(text) as PhoneNumberInfo;
    const name = [info.verified_name, info.display_phone_number].filter(Boolean).join(" · ");
    return { ok: true, detail: name ? `WhatsApp number: ${name}` : "WhatsApp number found.", info, live };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200), info: {}, live };
  }
}

// ── Templates ───────────────────────────────────────────────────────────────
export interface WhatsAppTemplate {
  id: string;
  provider: "whatsapp_cloud" | "twilio";
  external_id: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejected_reason: string | null;
  quality_score: string | null;
  body_params: number;
  header_params: number;
  header_format: string | null;
  /** Variable keys in send order: header first, then body ("1", "2" … or names). */
  variables: string[];
  parameter_format: string | null;
  body_text: string | null;
  header_text: string | null;
  footer_text: string | null;
  synced_at: Date;
}

/** Fetches the account's message templates from the Graph API and stores them (replacing the previous Meta sync). */
export async function syncTemplates(ctx: TenantContext | SyncScope, environmentId: string): Promise<{ templates: number; approved: number }> {
  const scope = syncScope(ctx);
  const { id, creds } = await withTenant(scope, (db) => credsOf(db, environmentId));
  type Fetched = { id?: string; name: string; language: string; status: string; category?: string; components?: TemplateComponent[]; rejected_reason?: string; quality_score?: { score?: string } };
  const fetched: Fetched[] = [];
  let url: string | null = templatesUrl(graphBase(), graphVersion(), creds.wabaId);
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: auth(creds), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) {
      const e = graphFailure(res.status, text);
      await withTenant(scope, (db) => markIntegration(db, id, `Template sync: ${e.message}`));
      throw new ValidationError(`WhatsApp said: ${e.message}`);
    }
    const body = JSON.parse(text) as { data?: Fetched[]; paging?: { next?: string } };
    fetched.push(...(body.data ?? []).filter((t) => t?.name && t?.language));
    const next: string | undefined = body.paging?.next;
    // Only follow pagination on the same host we called.
    url = next && new URL(next).origin === new URL(graphBase()).origin ? next : null;
  }
  return withTenant(scope, async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    const rows = fetched.map((t) => {
      const components = Array.isArray(t.components) ? t.components : [];
      const v = templateVariables(components);
      return {
        external_id: t.id ?? null, name: t.name.slice(0, 512), language: t.language.slice(0, 20), category: t.category ?? null, status: t.status,
        rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null, components,
        body_params: v.body.length, header_params: v.header.length, header_format: v.headerFormat, variables: [...v.header, ...v.body], parameter_format: v.parameterFormat,
        quality_score: t.quality_score?.score ?? null,
      };
    });
    await upsertTemplates(db, scope.organizationId, env!.app_id, environmentId, id, "whatsapp_cloud", rows);
    await markIntegration(db, id, null);
    return { templates: rows.length, approved: rows.filter((r) => r.status === "APPROVED").length };
  });
}

const TEMPLATE_COLUMNS = `id, provider, external_id, name, language, category, status, rejected_reason, quality_score, body_params, header_params, header_format,
  variables, parameter_format, synced_at,
  (select c->>'text' from jsonb_array_elements(components) c where upper(c->>'type') = 'BODY' limit 1) as body_text,
  (select c->>'text' from jsonb_array_elements(components) c where upper(c->>'type') = 'HEADER' and upper(coalesce(c->>'format', 'TEXT')) = 'TEXT' limit 1) as header_text,
  (select c->>'text' from jsonb_array_elements(components) c where upper(c->>'type') = 'FOOTER' limit 1) as footer_text`;

/** Synced templates of every connected WhatsApp provider in the environment. */
export function listTemplates(ctx: TenantContext, environmentId: string): Promise<WhatsAppTemplate[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query<WhatsAppTemplate>(`select ${TEMPLATE_COLUMNS} from platform.whatsapp_templates where environment_id = $1 order by name, language, provider`, [environmentId]),
  );
}

export function findTemplate(db: Db, environmentId: string, name: string, language: string, provider: "whatsapp_cloud" | "twilio" = "whatsapp_cloud"): Promise<WhatsAppTemplate | null> {
  return db.one<WhatsAppTemplate>(`select ${TEMPLATE_COLUMNS} from platform.whatsapp_templates where environment_id = $1 and name = $2 and language = $3 and provider = $4`, [environmentId, name, language, provider]);
}

/** Submits a template to Meta for review (POST /{waba-id}/message_templates). Returns Meta's template id and status. */
export async function submitTemplate(ctx: TenantContext, environmentId: string, draft: TemplateDraft): Promise<{ id: string | null; status: string }> {
  const { creds } = await tenantTx(ctx, "integrations.manage", (db) => credsOf(db, environmentId));
  const res = await fetch(templateCreateUrl(graphBase(), graphVersion(), creds.wabaId), {
    method: "POST",
    headers: { ...auth(creds), "Content-Type": "application/json" },
    body: JSON.stringify(templateCreateBody(draft)),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new ValidationError(`WhatsApp said: ${graphFailure(res.status, text).message}`);
  const body = JSON.parse(text) as { id?: string; status?: string };
  return { id: body.id ?? null, status: (body.status ?? "PENDING").toUpperCase() };
}

/** Deletes a template in the customer's WhatsApp Business account (one language with its id, else every language of the name), then forgets it here. */
export async function deleteTemplate(ctx: TenantContext, environmentId: string, name: string, templateId: string | null): Promise<void> {
  const { creds } = await tenantTx(ctx, "integrations.manage", (db) => credsOf(db, environmentId));
  const res = await fetch(templateDeleteUrl(graphBase(), graphVersion(), creds.wabaId, name, templateId), { method: "DELETE", headers: auth(creds), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new ValidationError(`WhatsApp said: ${graphFailure(res.status, await res.text()).message}`);
  await tenantTx(ctx, "integrations.manage", (db) =>
    db.query(
      "delete from platform.whatsapp_templates where environment_id = $1 and provider = 'whatsapp_cloud' and name = $2 and ($3::text is null or external_id = $3)",
      [environmentId, name, templateId],
    ),
  );
}

// ── Sending ─────────────────────────────────────────────────────────────────
export interface WhatsAppOutcome {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  /** The person opted out of marketing messages on WhatsApp: suppress them. */
  optedOut: boolean;
  live: boolean;
}

async function post(creds: WhatsAppCredentials, body: Record<string, unknown>): Promise<WhatsAppOutcome> {
  const live = isLiveGraph();
  try {
    const res = await fetch(messagesUrl(graphBase(), graphVersion(), creds.phoneNumberId), {
      method: "POST",
      headers: { ...auth(creds), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok) {
      const id = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
      return { ok: true, messageId: id, error: null, optedOut: false, live };
    }
    const e = graphFailure(res.status, text);
    return { ok: false, messageId: null, error: `WhatsApp ${e.message}`, optedOut: e.code !== null && OPT_OUT_ERROR_CODES.has(e.code), live };
  } catch (err) {
    return { ok: false, messageId: null, error: (err as Error).message.slice(0, 300), optedOut: false, live };
  }
}

export const sendTemplate = (creds: WhatsAppCredentials, msg: TemplateSend) => post(creds, templateMessageBody(msg));
/** A free-form message; the caller checks the 24-hour window first (WhatsApp rejects it otherwise, error 131047). */
export const sendSession = (creds: WhatsAppCredentials, msg: SessionSend) => post(creds, sessionMessageBody(msg));

// ── Webhook ─────────────────────────────────────────────────────────────────
interface WebhookIntegration {
  id: string;
  organization_id: string;
  environment_id: string;
  config: Record<string, string>;
  secret_ciphertext: string | null;
  verify_token_hash: string | null;
}

async function loadWebhookIntegration(db: Db, integrationId: string): Promise<WebhookIntegration | null> {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) return null;
  return db.one<WebhookIntegration>(
    "select id, organization_id, environment_id, config, secret_ciphertext, verify_token_hash from platform.integrations where id = $1 and provider = 'whatsapp' and status <> 'disabled'",
    [integrationId],
  );
}

/** GET handshake: returns hub.challenge when the verify token matches, else null. */
export async function verifySubscription(integrationId: string, q: URLSearchParams): Promise<string | null> {
  if (q.get("hub.mode") !== "subscribe") return null;
  const token = q.get("hub.verify_token") ?? "";
  const challenge = q.get("hub.challenge") ?? "";
  if (!token || !challenge || challenge.length > 200) return null;
  const row = await withSystem((db) => loadWebhookIntegration(db, integrationId));
  if (!row?.verify_token_hash || sha256(token) !== row.verify_token_hash) return null;
  return challenge;
}

/**
 * POST notification: verifies X-Hub-Signature-256 with the app secret, then
 * applies delivery statuses to `notifications`, records inbound messages
 * (opening the 24-hour window and feeding inbound-message flow triggers), and
 * turns opt-out replies (STOP / إيقاف, the "Stop promotions" button) into
 * WhatsApp suppressions.
 */
export async function handleWebhook(integrationId: string, rawBody: string, signature: string | null): Promise<{ statuses: number; optOuts: number; inbound: number }> {
  return withSystem(async (db) => {
    const row = await loadWebhookIntegration(db, integrationId);
    if (!row) throw new NotFoundError("Webhook");
    let appSecret: string;
    try {
      appSecret = (JSON.parse(decryptSecret(row.secret_ciphertext ?? "", `integration:${row.id}`)) as { appSecret: string }).appSecret;
    } catch (err) {
      log.error("whatsapp.webhook_secret_unavailable", { integration_id: row.id, error: err });
      throw new UnauthorizedError("Signature can't be checked.");
    }
    if (!verifyHubSignature(appSecret, signature, rawBody)) throw new UnauthorizedError("Invalid signature.");
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new ValidationError("Body is not JSON.");
    }
    let statuses = 0;
    let optOuts = 0;
    let inbound = 0;
    for (const batch of parseWebhook(payload)) {
      if (batch.phoneNumberId !== row.config.phone_number_id) continue; // another number on the same app
      for (const s of batch.statuses) {
        const n = await db.one<{ id: string; user_key: string }>(
          `update platform.notifications
              set status = case when $3 = 'failed' then 'failed'
                                when array_position(array['queued', 'sent', 'delivered', 'read'], $3) > coalesce(array_position(array['queued', 'sent', 'delivered', 'read'], status), 99) then $3
                                else status end,
                  delivered_at = case when $3 in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end,
                  read_at = case when $3 = 'read' then coalesce(read_at, now()) else read_at end,
                  error = case when $3 = 'failed' then $4 else error end
            where environment_id = $1 and provider_message_id = $2 and channel = 'whatsapp'
            returning id, user_key`,
          [row.environment_id, s.messageId, s.status, s.error],
        );
        if (!n) continue;
        statuses++;
        if (s.status === "failed" && s.errorCode !== null && OPT_OUT_ERROR_CODES.has(s.errorCode)) {
          if (await recordUnsubscribe(db, { organizationId: row.organization_id, environmentId: row.environment_id, userKey: n.user_key, channel: "whatsapp", reason: "WhatsApp: user stopped marketing messages" })) optOuts++;
        }
      }
      for (const m of batch.messages) {
        const r = await recordInbound(db, {
          organizationId: row.organization_id, environmentId: row.environment_id, integrationId: row.id, provider: "whatsapp_cloud", channel: "whatsapp",
          providerMessageId: m.id ?? null, from: m.from, body: m.text, type: m.type ?? "text",
          receivedAt: m.timestamp ? new Date(Math.min(m.timestamp * 1000, Date.now())) : new Date(), optOut: isOptOut(m.text), optOutReason: "WhatsApp reply: opt-out keyword",
        });
        if (r.stored) inbound++;
        if (r.optedOut) optOuts++;
      }
    }
    return { statuses, optOuts, inbound };
  });
}
