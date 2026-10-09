import "server-only";
import type { Db } from "@/lib/db";
import { recordUnsubscribe, splitUserKey } from "@/modules/messaging/consent";
import { issueUnsubscribeToken } from "@/modules/messaging/email";
import { buildEmail } from "@/modules/messaging/email-content";
import { markIntegration, sendCustomerEmail, type DeliveryCredentials } from "@/modules/messaging/integrations";
import { APNS_HOSTS, type PushContent } from "@/modules/push/messages";
import { apnsBaseUrl, fcmBaseUrl, sendApns, sendFcm, type PushOutcome } from "@/modules/push/transport";
import { recordUsage } from "@/modules/usage/service";
import { senderHash } from "@/modules/messaging/inbound";
import { sendThrough, type OutboundMessage } from "@/modules/messaging/providers/adapters";

/**
 * Sending one message to one person through the customer's providers, and
 * recording it in `notifications`. Shared by the automation engine (a run's
 * message step) and test sends (no run). Callers check consent first.
 */

export interface Target {
  organizationId: string;
  environmentId: string;
  userKey: string;
  /** The automation run and step, or null for a test send. */
  runId: string | null;
  step: number | null;
}

const PROVIDER_LABEL = { fcm: "FCM", apns: "APNs" } as const;
const NOTIFICATION_CONFLICT = `on conflict (automation_run_id, step, coalesce(push_token_id, '00000000-0000-0000-0000-000000000000'::uuid)) where automation_run_id is not null do nothing`;

async function finish(db: Db, id: string, ok: boolean, error: string | null, providerId: string | null | undefined) {
  await db.query("update platform.notifications set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end, provider_message_id = $4 where id = $1", [
    id, ok ? "sent" : "failed", error, providerId ?? null,
  ]);
}

export async function pushTokens(db: Db, environmentId: string, userKey: string) {
  const { userId, anonymousId } = splitUserKey(userKey);
  return db.query<{ id: string; token: string; provider: "fcm" | "apns" }>(
    `select t.id, t.token, t.provider from platform.push_tokens t
      where t.environment_id = $1 and t.status = 'active' and t.permission_state <> 'denied'
        and (($2::text is not null and (t.user_id = $2 or (t.user_id is null and t.anonymous_id in (
                select anonymous_id from platform.identity_links where environment_id = $1 group by anonymous_id having count(*) = 1 and min(user_id) = $2))))
             or ($3::text is not null and t.user_id is null and t.anonymous_id = $3))
      order by t.last_seen_at desc limit 10`,
    [environmentId, userId, anonymousId],
  );
}

/** Push to every active device of the person. Already-attempted devices (same run step) are skipped. */
export async function deliverPush(db: Db, creds: DeliveryCredentials, t: Target, content: PushContent): Promise<{ sent: number; devices: number; problems: string[] }> {
  const tokens = await pushTokens(db, t.environmentId, t.userKey);
  let sent = 0;
  const problems: string[] = [];
  for (const tok of tokens) {
    const notif = await db.one<{ id: string }>(
      `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, automation_run_id, step, push_token_id, status, payload)
       values ($1, $2, 'push', $3, $4, $5, $6, $7, 'queued', $8) ${NOTIFICATION_CONFLICT} returning id`,
      [t.organizationId, t.environmentId, tok.provider, t.userKey, t.runId, t.step, tok.id, JSON.stringify({ title: content.title, body: content.body, data: content.data, ...(t.runId ? {} : { test: true }) })],
    );
    if (!notif) continue; // already attempted for this token
    let outcome: PushOutcome;
    let integrationId: string | null = null;
    let live = false;
    if (tok.provider === "fcm" && creds.fcm) {
      integrationId = creds.fcm.id;
      live = fcmBaseUrl() === "https://fcm.googleapis.com";
      outcome = await sendFcm(creds.fcm.sa, tok.token, content);
    } else if (tok.provider === "apns" && creds.apns) {
      integrationId = creds.apns.id;
      live = apnsBaseUrl(creds.apns.creds.environment) === APNS_HOSTS[creds.apns.creds.environment];
      outcome = await sendApns(creds.apns.creds, tok.token, content);
    } else {
      const why = creds.errors[tok.provider] ? `${PROVIDER_LABEL[tok.provider]} credentials can't be read` : `${PROVIDER_LABEL[tok.provider]} is not connected`;
      outcome = { ok: false, invalidToken: false, status: null, error: why };
    }
    await finish(db, notif.id, outcome.ok, outcome.error, outcome.providerId);
    if (integrationId) await markIntegration(db, integrationId, outcome.ok || outcome.invalidToken ? null : outcome.error, live && outcome.ok);
    if (outcome.invalidToken) await db.query("update platform.push_tokens set status = 'invalid', invalidated_at = now() where id = $1", [tok.id]);
    if (outcome.ok) sent++;
    else problems.push(outcome.invalidToken ? `${tok.provider} token invalid (deactivated)` : (outcome.error ?? "failed"));
  }
  if (sent) await recordUsage(db, t.organizationId, "push_messages", sent);
  return { sent, devices: tokens.length, problems: [...new Set(problems)] };
}

export interface DeliveryResult {
  /** False when this run step was already attempted (nothing sent now). */
  attempted: boolean;
  ok: boolean;
  error: string | null;
}

/** One email from the customer's Resend account, with an unsubscribe link. `body` and `subject` are already rendered. */
export async function deliverEmail(
  db: Db,
  creds: DeliveryCredentials,
  t: Target,
  msg: { to: string; subject: string; body: string; templateId: string | null; tag: string },
): Promise<DeliveryResult> {
  const unsubscribe = issueUnsubscribeToken();
  const notif = await db.one<{ id: string }>(
    `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, automation_run_id, step, status, payload, unsubscribe_token_hash)
     values ($1, $2, 'email', 'resend', $3, $4, $5, 'queued', $6, $7) ${NOTIFICATION_CONFLICT} returning id`,
    [t.organizationId, t.environmentId, t.userKey, t.runId, t.step, JSON.stringify({ subject: msg.subject, template_id: msg.templateId, ...(t.runId ? {} : { test: true }) }), unsubscribe.hash],
  );
  if (!notif) return { attempted: false, ok: false, error: null };
  let result: { ok: boolean; error: string | null; id?: string };
  if (!creds.resend) {
    result = { ok: false, error: creds.errors.resend ? "Email credentials can't be read" : "Email (Resend) is not connected" };
  } else {
    const email = buildEmail(msg.body, unsubscribe.url);
    const r = await sendCustomerEmail(creds.resend.creds, { to: msg.to, subject: msg.subject, text: email.text, html: email.html, headers: email.headers, tag: msg.tag });
    result = r;
    await markIntegration(db, creds.resend.id, r.ok ? null : r.error, r.live && r.ok);
    if (r.ok) await recordUsage(db, t.organizationId, "email_messages", 1);
  }
  await finish(db, notif.id, result.ok, result.error, result.id);
  return { attempted: true, ok: result.ok, error: result.error };
}

/**
 * One WhatsApp or SMS message through a provider adapter (Meta Cloud API or
 * Twilio): approved templates or free-form text/media. Params are already
 * rendered and media already resolved to a URL. The caller checks consent,
 * the 24-hour window and template approval first.
 */
export async function deliverMessage(db: Db, creds: DeliveryCredentials, t: Target, providerId: "whatsapp_cloud" | "twilio", m: OutboundMessage): Promise<DeliveryResult> {
  const payload = m.kind === "template"
    ? { kind: "template", template: m.template, language: m.language, ...(m.headerMedia ? { media: m.headerMedia.kind } : {}) }
    : { kind: "text", length: m.text.length, ...(m.media ? { media: m.media.kind } : {}) };
  const notif = await db.one<{ id: string }>(
    `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, automation_run_id, step, status, payload, recipient_hash)
     values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9) ${NOTIFICATION_CONFLICT} returning id`,
    [t.organizationId, t.environmentId, m.channel, providerId, t.userKey, t.runId, t.step, JSON.stringify({ ...payload, ...(t.runId ? {} : { test: true }) }), senderHash(t.environmentId, m.to)],
  );
  if (!notif) return { attempted: false, ok: false, error: null };
  const r = await sendThrough(providerId, creds, m);
  if (r.integrationId) await markIntegration(db, r.integrationId, r.ok || r.optedOut ? null : r.error, r.live && r.ok);
  if (r.optedOut) {
    await recordUnsubscribe(db, {
      organizationId: t.organizationId, environmentId: t.environmentId, userKey: t.userKey, channel: m.channel,
      reason: m.channel === "whatsapp" ? "WhatsApp: user stopped marketing messages" : "SMS: recipient opted out (STOP)",
    });
  }
  await finish(db, notif.id, r.ok, r.error, r.messageId);
  if (r.ok) await recordUsage(db, t.organizationId, m.channel === "sms" ? "sms_messages" : "whatsapp_messages", 1);
  return { attempted: true, ok: r.ok, error: r.error };
}

/** One approved WhatsApp template message through Meta's Cloud API. Params are already rendered. */
export function deliverWhatsApp(
  db: Db,
  creds: DeliveryCredentials,
  t: Target,
  msg: { to: string; template: string; language: string; bodyParams: string[]; headerParams: string[] },
): Promise<DeliveryResult> {
  const keys = [...msg.headerParams.map((_, i) => String(i + 1)), ...msg.bodyParams.map((_, i) => String(i + 1))];
  return deliverMessage(db, creds, t, "whatsapp_cloud", { kind: "template", channel: "whatsapp", ...msg, variableKeys: keys });
}
