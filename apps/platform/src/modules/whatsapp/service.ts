import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { decryptSecret } from "@/lib/secret-box";
import { log } from "@/lib/log";
import { recordUnsubscribe } from "@/modules/messaging/consent";
import { markIntegration, sha256, type WhatsAppCredentials } from "@/modules/messaging/integrations";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { deploymentOf } from "@/server/config";
import {
  DEFAULT_GRAPH_VERSION, GRAPH_HOST, graphError, isOptOut, messagesUrl, OPT_OUT_ERROR_CODES, parseWebhook, templateMessageBody, templateParams,
  templatesUrl, verifyHubSignature, type TemplateComponent, type TemplateSend,
} from "./messages";

/**
 * WhatsApp Business Cloud API: template sync, sending approved templates,
 * and the webhook for delivery statuses and opt-out replies. Credentials are
 * the customer's own (per environment, encrypted; see messaging/integrations).
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

const recipientHash = (environmentId: string, waId: string) => sha256(`${environmentId}:${waId.replace(/^\+/, "")}`);

// ── Templates ───────────────────────────────────────────────────────────────
export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  body_params: number;
  header_params: number;
  body_text: string | null;
  synced_at: Date;
}

/** Fetches the account's message templates from the Graph API and stores them (replacing the previous sync). */
export async function syncTemplates(ctx: TenantContext, environmentId: string): Promise<{ templates: number; approved: number }> {
  const integration = await tenantTx(ctx, "integrations.manage", (db) =>
    db.one<{ id: string; secret_ciphertext: string | null; config: Record<string, string> }>(
      "select id, secret_ciphertext, config from platform.integrations where environment_id = $1 and provider = 'whatsapp'",
      [environmentId],
    ),
  );
  if (!integration) throw new NotFoundError("WhatsApp integration");
  const { accessToken } = JSON.parse(decryptSecret(integration.secret_ciphertext ?? "", `integration:${integration.id}`)) as { accessToken: string };
  const fetched: { id?: string; name: string; language: string; status: string; category?: string; components?: TemplateComponent[] }[] = [];
  let url: string | null = templatesUrl(graphBase(), graphVersion(), integration.config.waba_id);
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) {
      const e = graphError(res.status, text);
      await tenantTx(ctx, "integrations.manage", (db) => markIntegration(db, integration.id, `Template sync: ${e.message}`));
      throw new ValidationError(`WhatsApp said: ${e.message}`);
    }
    const body = JSON.parse(text) as { data?: typeof fetched; paging?: { next?: string } };
    fetched.push(...(body.data ?? []).filter((t) => t?.name && t?.language));
    const next: string | undefined = body.paging?.next;
    // Only follow pagination on the same host we called.
    url = next && new URL(next).origin === new URL(graphBase()).origin ? next : null;
  }
  return tenantTx(ctx, "integrations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    const rows = fetched.map((t) => {
      const components = Array.isArray(t.components) ? t.components : [];
      const p = templateParams(components);
      return { external_id: t.id ?? null, name: t.name.slice(0, 512), language: t.language.slice(0, 20), category: t.category ?? null, status: t.status, components, body_params: p.body, header_params: p.header };
    });
    await db.query("delete from platform.whatsapp_templates where environment_id = $1", [environmentId]);
    if (rows.length) {
      await db.query(
        `insert into platform.whatsapp_templates (organization_id, app_id, environment_id, integration_id, external_id, name, language, category, status, components, body_params, header_params)
         select $1, $2, $3, $4, r.external_id, r.name, r.language, r.category, r.status, r.components, r.body_params, r.header_params
           from jsonb_to_recordset($5::jsonb) as r(external_id text, name text, language text, category text, status text, components jsonb, body_params int, header_params int)
         on conflict (environment_id, name, language) do nothing`,
        [ctx.organizationId, env!.app_id, environmentId, integration.id, JSON.stringify(rows)],
      );
    }
    await markIntegration(db, integration.id, null);
    return { templates: rows.length, approved: rows.filter((r) => r.status === "APPROVED").length };
  });
}

const TEMPLATE_COLUMNS = `id, name, language, category, status, body_params, header_params, synced_at,
  (select c->>'text' from jsonb_array_elements(components) c where upper(c->>'type') = 'BODY' limit 1) as body_text`;

export function listTemplates(ctx: TenantContext, environmentId: string): Promise<WhatsAppTemplate[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query<WhatsAppTemplate>(`select ${TEMPLATE_COLUMNS} from platform.whatsapp_templates where environment_id = $1 order by name, language`, [environmentId]),
  );
}

export function findTemplate(db: Db, environmentId: string, name: string, language: string): Promise<WhatsAppTemplate | null> {
  return db.one<WhatsAppTemplate>(`select ${TEMPLATE_COLUMNS} from platform.whatsapp_templates where environment_id = $1 and name = $2 and language = $3`, [environmentId, name, language]);
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

export async function sendTemplate(creds: WhatsAppCredentials, msg: TemplateSend): Promise<WhatsAppOutcome> {
  const live = isLiveGraph();
  try {
    const res = await fetch(messagesUrl(graphBase(), graphVersion(), creds.phoneNumberId), {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(templateMessageBody(msg)),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok) {
      const id = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id ?? null;
      return { ok: true, messageId: id, error: null, optedOut: false, live };
    }
    const e = graphError(res.status, text);
    return { ok: false, messageId: null, error: `WhatsApp ${e.message}`, optedOut: e.code !== null && OPT_OUT_ERROR_CODES.has(e.code), live };
  } catch (err) {
    return { ok: false, messageId: null, error: (err as Error).message.slice(0, 300), optedOut: false, live };
  }
}

/** Hash stored on the notification so an inbound STOP can be matched to the person without keeping the number. */
export { recipientHash };

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
 * applies delivery statuses to `notifications` and turns opt-out replies
 * (STOP / إيقاف, the "Stop promotions" button) into WhatsApp suppressions.
 */
export async function handleWebhook(integrationId: string, rawBody: string, signature: string | null): Promise<{ statuses: number; optOuts: number }> {
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
        if (!isOptOut(m.text)) continue;
        const people = await db.query<{ user_key: string }>(
          "select distinct user_key from platform.notifications where environment_id = $1 and channel = 'whatsapp' and recipient_hash = $2",
          [row.environment_id, recipientHash(row.environment_id, m.from)],
        );
        for (const p of people) {
          if (await recordUnsubscribe(db, { organizationId: row.organization_id, environmentId: row.environment_id, userKey: p.user_key, channel: "whatsapp", reason: "WhatsApp reply: opt-out keyword" })) optOuts++;
        }
      }
    }
    return { statuses, optOuts };
  });
}
