import "server-only";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { syncScope, type SyncScope } from "@/modules/messaging/template-store";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { decryptSecret } from "@/lib/secret-box";
import { log } from "@/lib/log";
import { recordInbound } from "@/modules/messaging/inbound";
import { integrationSecret, markIntegration, twilioCreds } from "@/modules/messaging/integrations";
import { recordUnsubscribe } from "@/modules/messaging/consent";
import { upsertTemplates } from "@/modules/messaging/template-store";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { isOptOut } from "@/modules/whatsapp/messages";
import { deploymentOf } from "@/server/config";
import { publicBaseUrl } from "@/server/env";
import {
  accountUrl, basicAuth, contentListUrl, contentUrl, explainTwilioError, messageForm, messagesUrl, parseContent, parseTwilioCallback, TWILIO_API,
  TWILIO_CONTENT_API, TWILIO_OPT_OUT_CODES, twilioError, verifyTwilioSignature, type ContentTemplate, type TwilioCredentials, type TwilioSend,
} from "./messages";

/**
 * Twilio adapter: SMS (MMS where Twilio allows it), WhatsApp through a
 * Twilio WhatsApp sender, Content templates with their WhatsApp approval, and
 * the signed status/inbound callback. Credentials are the customer's own
 * (per environment, encrypted; see messaging/integrations).
 *
 * TWILIO_API_BASE_URL and TWILIO_CONTENT_API_BASE_URL point at a local mock,
 * only outside deployments. A send to the real API that succeeds marks the
 * integration as verified live.
 */
const local = () => deploymentOf(process.env) === "local";
export const twilioBase = () => (local() && process.env.TWILIO_API_BASE_URL) || TWILIO_API;
export const contentBase = () => (local() && process.env.TWILIO_CONTENT_API_BASE_URL) || TWILIO_CONTENT_API;
export const isLiveTwilio = () => twilioBase() === TWILIO_API;

/** The callback URL Twilio signs: status callbacks and the inbound webhook of one integration. */
export const twilioCallbackUrl = (integrationId: string) => `${publicBaseUrl()}/v1/twilio/webhook/${integrationId}`;

const explain = (code: number | null, message: string) => {
  const hint = explainTwilioError(code);
  return `Twilio ${message}${hint ? ` (${hint})` : ""}`;
};

// ── Connection ──────────────────────────────────────────────────────────────
/** GET the account with the stored credentials: proves the SID and token work, and reports the account status. */
export async function verifyTwilio(creds: TwilioCredentials): Promise<{ ok: boolean; detail: string; live: boolean }> {
  const live = isLiveTwilio();
  try {
    const res = await fetch(accountUrl(twilioBase(), creds.accountSid), { headers: { Authorization: basicAuth(creds) }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) {
      const e = twilioError(res.status, text);
      return { ok: false, detail: explain(e.code, e.message), live };
    }
    const a = JSON.parse(text) as { status?: string; friendly_name?: string };
    if (a.status && a.status !== "active") return { ok: false, detail: `Twilio account is ${a.status}.`, live };
    return { ok: true, detail: a.friendly_name ? `Twilio account: ${a.friendly_name.slice(0, 80)}` : "Twilio account is active.", live };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200), live };
  }
}

// ── Sending ─────────────────────────────────────────────────────────────────
export interface TwilioOutcome {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  optedOut: boolean;
  live: boolean;
}

export async function sendTwilio(creds: TwilioCredentials, integrationId: string, m: Omit<TwilioSend, "statusCallback">): Promise<TwilioOutcome> {
  const live = isLiveTwilio();
  if (m.channel === "whatsapp" && !creds.whatsappFrom) return { ok: false, messageId: null, error: "No WhatsApp sender is set on the Twilio integration.", optedOut: false, live };
  if (m.channel === "sms" && !creds.messagingServiceSid && !creds.fromNumber) return { ok: false, messageId: null, error: "No SMS sender is set on the Twilio integration.", optedOut: false, live };
  try {
    const res = await fetch(messagesUrl(twilioBase(), creds.accountSid), {
      method: "POST",
      headers: { Authorization: basicAuth(creds), "Content-Type": "application/x-www-form-urlencoded" },
      body: messageForm(creds, { ...m, statusCallback: twilioCallbackUrl(integrationId) }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.ok) {
      const body = JSON.parse(text) as { sid?: string; status?: string; error_code?: number | null };
      if (body.status === "failed") return { ok: false, messageId: body.sid ?? null, error: explain(body.error_code ?? null, `failed ${body.error_code ?? ""}`.trim()), optedOut: false, live };
      return { ok: true, messageId: body.sid ?? null, error: null, optedOut: false, live };
    }
    const e = twilioError(res.status, text);
    return { ok: false, messageId: null, error: explain(e.code, e.message), optedOut: e.code !== null && TWILIO_OPT_OUT_CODES.has(e.code), live };
  } catch (err) {
    return { ok: false, messageId: null, error: (err as Error).message.slice(0, 300), optedOut: false, live };
  }
}

// ── Content templates (WhatsApp approval) ───────────────────────────────────
async function credsFor(db: Db, environmentId: string): Promise<{ id: string; creds: TwilioCredentials }> {
  const row = await integrationSecret(db, environmentId, "twilio");
  if (!row) throw new NotFoundError("Twilio integration");
  return { id: row.id, creds: twilioCreds(row.config, row.secret) };
}

/** Reads every Content template with its WhatsApp approval into whatsapp_templates (provider 'twilio'), replacing the previous Twilio sync. */
export async function syncTwilioTemplates(ctx: TenantContext | SyncScope, environmentId: string): Promise<{ templates: number; approved: number }> {
  const scope = syncScope(ctx);
  const { id, creds } = await withTenant(scope, (db) => credsFor(db, environmentId));
  const fetched: ContentTemplate[] = [];
  let url: string | null = contentListUrl(contentBase());
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: basicAuth(creds) }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) {
      const e = twilioError(res.status, text);
      await withTenant(scope, (db) => markIntegration(db, id, `Template sync: ${e.message}`));
      throw new ValidationError(explain(e.code, e.message));
    }
    const body = JSON.parse(text) as { contents?: unknown[]; meta?: { next_page_url?: string | null } };
    for (const c of body.contents ?? []) {
      const t = parseContent(c);
      if (t) fetched.push(t);
    }
    const next = body.meta?.next_page_url;
    url = next && new URL(next).origin === new URL(contentBase()).origin ? next : null;
  }
  return withTenant(scope, async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    const rows = fetched.map((t) => {
      const keys = Object.keys(t.variables).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
      return {
        external_id: t.sid, name: t.name, language: t.language, category: t.category, status: t.status, rejected_reason: t.rejectedReason,
        components: [...(t.mediaHeader ? [{ type: "HEADER", format: "IMAGE" }] : []), { type: "BODY", text: t.body ?? "" }],
        body_params: keys.length, header_params: 0, header_format: t.mediaHeader ? "IMAGE" : null, variables: keys,
        parameter_format: keys.some((k) => !/^\d+$/.test(k)) ? "NAMED" : "POSITIONAL",
      };
    });
    await upsertTemplates(db, scope.organizationId, env!.app_id, environmentId, id, "twilio", rows);
    await markIntegration(db, id, null);
    return { templates: rows.length, approved: rows.filter((r) => r.status === "APPROVED").length };
  });
}

/** Deletes a Content template in the customer's Twilio account, then forgets it here. */
export async function deleteTwilioTemplate(ctx: TenantContext, environmentId: string, contentSid: string): Promise<void> {
  const { creds } = await tenantTx(ctx, "integrations.manage", (db) => credsFor(db, environmentId));
  const res = await fetch(contentUrl(contentBase(), contentSid), { method: "DELETE", headers: { Authorization: basicAuth(creds) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok && res.status !== 404) {
    const e = twilioError(res.status, await res.text());
    throw new ValidationError(explain(e.code, e.message));
  }
  await tenantTx(ctx, "integrations.manage", (db) =>
    db.query("delete from platform.whatsapp_templates where environment_id = $1 and provider = 'twilio' and external_id = $2", [environmentId, contentSid]),
  );
}

// ── Callback (status + inbound) ─────────────────────────────────────────────
interface CallbackIntegration {
  id: string;
  organization_id: string;
  environment_id: string;
  secret_ciphertext: string | null;
}

/**
 * POST from Twilio: verifies X-Twilio-Signature against the callback URL we
 * gave Twilio, then applies a delivery status to the notification, or records
 * an inbound message (opt-out keywords and Twilio's OptOutType=STOP suppress
 * the person on that channel).
 */
export async function handleTwilioWebhook(integrationId: string, rawBody: string, signature: string | null): Promise<{ kind: string; applied: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) throw new NotFoundError("Webhook");
  return withSystem(async (db) => {
    const row = await db.one<CallbackIntegration>(
      "select id, organization_id, environment_id, secret_ciphertext from platform.integrations where id = $1 and provider = 'twilio' and status <> 'disabled'",
      [integrationId],
    );
    if (!row) throw new NotFoundError("Webhook");
    let authToken: string;
    try {
      authToken = decryptSecret(row.secret_ciphertext ?? "", `integration:${row.id}`);
    } catch (err) {
      log.error("twilio.webhook_secret_unavailable", { integration_id: row.id, error: err });
      throw new UnauthorizedError("Signature can't be checked.");
    }
    const params = new URLSearchParams(rawBody);
    if (!verifyTwilioSignature(authToken, signature, twilioCallbackUrl(row.id), params)) throw new UnauthorizedError("Invalid signature.");
    const cb = parseTwilioCallback(params);
    if (cb.kind === "status") {
      const n = await db.one<{ id: string; user_key: string; channel: "sms" | "whatsapp" }>(
        `update platform.notifications
            set status = case when $3 = 'failed' then 'failed'
                              when array_position(array['queued', 'sent', 'delivered', 'read'], $3) > coalesce(array_position(array['queued', 'sent', 'delivered', 'read'], status), 99) then $3
                              else status end,
                delivered_at = case when $3 in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end,
                read_at = case when $3 = 'read' then coalesce(read_at, now()) else read_at end,
                error = case when $3 = 'failed' then $4 else error end
          where environment_id = $1 and provider_message_id = $2 and provider = 'twilio'
          returning id, user_key, channel`,
        [row.environment_id, cb.messageSid, cb.status, cb.error],
      );
      if (n && cb.status === "failed" && cb.errorCode !== null && TWILIO_OPT_OUT_CODES.has(cb.errorCode)) {
        await recordUnsubscribe(db, { organizationId: row.organization_id, environmentId: row.environment_id, userKey: n.user_key, channel: n.channel, reason: "Twilio: recipient opted out (STOP)" });
      }
      return { kind: "status", applied: Boolean(n) };
    }
    if (cb.kind === "inbound") {
      const optOut = cb.optOutType?.toUpperCase() === "STOP" || isOptOut(cb.body);
      const r = await recordInbound(db, {
        organizationId: row.organization_id, environmentId: row.environment_id, integrationId: row.id, provider: "twilio", channel: cb.channel,
        providerMessageId: cb.messageSid, from: cb.from, body: cb.body, type: cb.numMedia ? "media" : "text", receivedAt: new Date(), optOut,
        optOutReason: cb.channel === "sms" ? "SMS reply: opt-out keyword" : "WhatsApp reply: opt-out keyword",
      });
      return { kind: "inbound", applied: r.stored };
    }
    return { kind: "ignored", applied: false };
  });
}
