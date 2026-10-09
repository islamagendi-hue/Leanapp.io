import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translate";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { fill } from "@/modules/automation/messages";
import { messagingBlocked } from "@/modules/messaging/consent";
import { deliverEmail, deliverMessage, deliverPush, type Target } from "@/modules/messaging/deliver";
import { loadDeliveryCredentials } from "@/modules/messaging/integrations";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { toE164 } from "@/modules/whatsapp/messages";
import { findTemplate } from "@/modules/whatsapp/service";
import { applyAvailability, DELIVERY_CHANNELS, type DeliveryChannel, type DeliveryCounts } from "./metrics";

/**
 * Channels & delivery: delivery counts per channel from what was really
 * sent (notifications and in-app messages), and test sends to one person.
 */

// ── Counts ──────────────────────────────────────────────────────────────────
type Raw = { channel: DeliveryChannel; sent: number; failed: number; delivered: number; opened: number; clicked: number };

const NOTIFICATION_COUNTS = `
  select n.channel,
         count(*) filter (where n.status in ('sent', 'delivered', 'read', 'opened'))::int as sent,
         count(*) filter (where n.status = 'failed')::int as failed,
         count(*) filter (where n.delivered_at is not null or n.status in ('delivered', 'read', 'opened'))::int as delivered,
         count(*) filter (where n.read_at is not null or n.status in ('read', 'opened'))::int as opened,
         0 as clicked`;
const IN_APP_COUNTS = `
  select 'in_app' as channel, count(*)::int as sent, 0 as failed, 0 as delivered,
         count(*) filter (where m.displayed_at is not null)::int as opened,
         count(*) filter (where m.clicked_at is not null)::int as clicked`;

function byChannel(rows: Raw[], channels: readonly DeliveryChannel[] = DELIVERY_CHANNELS): Record<DeliveryChannel, DeliveryCounts> {
  const out = {} as Record<DeliveryChannel, DeliveryCounts>;
  for (const c of channels) {
    const r = rows.find((x) => x.channel === c) ?? { sent: 0, failed: 0, delivered: 0, opened: 0, clicked: 0 };
    out[c] = applyAvailability(c, r);
  }
  return out;
}

/** Messages from campaigns and flows in the environment over the last `days` days (test sends excluded). */
export async function deliveryByChannel(ctx: TenantContext, environmentId: string, days: number): Promise<Record<DeliveryChannel, DeliveryCounts>> {
  const rows = await tenantTx(ctx, "automations.read", (db) =>
    db.query<Raw>(
      `${NOTIFICATION_COUNTS} from platform.notifications n
        where n.environment_id = $1 and n.created_at > now() - make_interval(days => $2) and n.automation_run_id is not null
        group by n.channel
       union all
       ${IN_APP_COUNTS} from platform.in_app_messages m
        where m.environment_id = $1 and m.created_at > now() - make_interval(days => $2) and m.automation_id is not null`,
      [environmentId, days],
    ),
  );
  return byChannel(rows);
}

/** Delivery counts of one automation or campaign (all time), for its channels. */
export async function deliveryOfAutomation(db: Db, automationId: string): Promise<Record<DeliveryChannel, DeliveryCounts>> {
  const rows = await db.query<Raw>(
    `${NOTIFICATION_COUNTS} from platform.notifications n join platform.automation_runs r on r.id = n.automation_run_id
      where r.automation_id = $1 group by n.channel
     union all
     ${IN_APP_COUNTS} from platform.in_app_messages m where m.automation_id = $1`,
    [automationId],
  );
  return byChannel(rows);
}

// ── Test sends ──────────────────────────────────────────────────────────────
export const TEST_SENDS_PER_HOUR = 20;

const testInput = z.object({
  channel: z.enum(DELIVERY_CHANNELS, msg("Choose a channel.")),
  userId: z.string().trim().min(1, msg("Enter the user ID of a person in this environment.")).max(200),
  /** WhatsApp only: an approved template "name|language" and its variables. */
  whatsappTemplate: z.string().optional(),
  whatsappParams: z.array(z.string().trim().max(1024)).max(20).default([]),
  phoneProperty: z.string().trim().max(64).optional().transform((v) => v || "phone"),
});

export interface TestResult {
  ok: boolean;
  message: string;
}

/**
 * Sends a test message to one person (by user ID) through the environment's
 * real provider, the same way campaigns and flows do: their devices, their
 * `email` property, their phone number property. Consent and suppression are
 * respected. The result says exactly what happened; a successful send to a
 * provider's live API marks the channel as verified.
 */
export async function sendTestMessage(ctx: TenantContext, environmentId: string, input: unknown): Promise<TestResult> {
  const r = testInput.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0].message);
  const { channel, userId } = r.data;
  return tenantTx(ctx, "automations.manage", async (db) => {
    const env = await db.one<{ app_id: string; type: string }>("select app_id, type from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const recent = await db.one<{ n: number }>(
      `select (select count(*)::int from platform.notifications where environment_id = $1 and automation_run_id is null and payload ? 'test' and created_at > now() - interval '1 hour')
            + (select count(*)::int from platform.in_app_messages where environment_id = $1 and automation_id is null and data ? 'test' and created_at > now() - interval '1 hour') as n`,
      [environmentId],
    );
    if (recent!.n >= TEST_SENDS_PER_HOUR) throw new ValidationError(fill(msg("At most {n} test messages an hour per environment. Try again later."), { n: TEST_SENDS_PER_HOUR }));
    const person = await db.one<{ properties: Record<string, unknown> }>("select properties from platform.app_users where environment_id = $1 and external_id = $2", [environmentId, userId]);
    if (!person) throw new ValidationError(fill(msg('No person with the user ID "{id}" in {env}. The app must have identified them first.'), { id: userId, env: env.type }));

    const result = await send(db, ctx, environmentId, env.app_id, env.type, channel, userId, person.properties, r.data);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "message.test_sent", targetType: "environment", targetId: environmentId, metadata: { channel, ok: result.ok } });
    return result;
  });
}

async function send(
  db: Db, ctx: TenantContext, environmentId: string, appId: string, envType: string, channel: DeliveryChannel, userId: string, profile: Record<string, unknown>,
  input: z.output<typeof testInput>,
): Promise<TestResult> {
  const blocked = await messagingBlocked(db, environmentId, userId, channel);
  if (blocked) return { ok: false, message: blocked === "suppressed" ? msg("Not sent: this person is on the suppression list.") : msg("Not sent: this person is opted out (consent denied).") };
  const target: Target = { organizationId: ctx.organizationId, environmentId, userKey: userId, runId: null, step: null };
  const title = "LeanApp test message";
  const body = `This is a test from LeanApp (${envType}). If you can read it, ${channel === "in_app" ? "in-app messages" : "this channel"} works.`;

  if (channel === "in_app") {
    await db.query(
      `insert into platform.in_app_messages (organization_id, app_id, environment_id, user_key, title, body, data, expires_at)
       values ($1, $2, $3, $4, $5, $6, '{"test": true}', now() + interval '24 hours')`,
      [ctx.organizationId, appId, environmentId, userId, title, body],
    );
    return { ok: true, message: msg("Queued. Your app shows it the next time it asks the in-app API for this person's messages (within 24 hours).") };
  }
  const creds = await loadDeliveryCredentials(db, environmentId);
  if (channel === "push") {
    const p = await deliverPush(db, creds, target, { title, body, data: { test: "true" } });
    if (!p.devices) return { ok: false, message: msg("Not sent: this person has no active push token. Open the app on a device with notifications allowed, then try again.") };
    return { ok: p.sent > 0, message: [fill(p.devices === 1 ? msg("Sent to {sent} of {devices} device.") : msg("Sent to {sent} of {devices} devices."), { sent: p.sent, devices: p.devices }), ...p.problems].join(" ") };
  }
  if (channel === "email") {
    const to = typeof profile.email === "string" ? profile.email.trim() : "";
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return { ok: false, message: msg("Not sent: this person has no valid email user property.") };
    const e = await deliverEmail(db, creds, target, { to, subject: title, body, templateId: null, tag: "test" });
    return { ok: e.ok, message: e.ok ? msg("Sent. Resend accepted the email.") : fill(msg("Not sent: {message}"), { message: String(e.error) }) };
  }
  if (channel === "sms") {
    const to = toE164(profile[input.phoneProperty]);
    if (!to) return { ok: false, message: fill(msg("Not sent: no valid E.164 phone number in the {property} user property."), { property: input.phoneProperty }) };
    const s = await deliverMessage(db, creds, target, "twilio", { kind: "text", channel: "sms", to, text: body });
    return { ok: s.ok, message: s.ok ? msg("Sent. Twilio accepted the SMS; delivery receipts arrive through the status callback.") : fill(msg("Not sent: {message}"), { message: String(s.error) }) };
  }
  // WhatsApp: only approved templates can start a conversation.
  const [name, language, providerRaw] = (input.whatsappTemplate ?? "").split("|");
  const provider = providerRaw === "twilio" ? "twilio" : "whatsapp_cloud";
  const template = name && language ? await findTemplate(db, environmentId, name, language, provider) : null;
  if (!template) return { ok: false, message: msg("Choose a synced WhatsApp template.") };
  if (template.status !== "APPROVED") return { ok: false, message: fill(msg("Not sent: the template {name} is {status}, not approved."), { name, status: template.status.toLowerCase() }) };
  if (template.header_format && template.header_format !== "TEXT") {
    return { ok: false, message: fill(msg("The template {name} has a media header, which test sends don't attach. Test it from a campaign."), { name }) };
  }
  if (template.header_params > 0 || template.body_params !== input.whatsappParams.length) {
    return { ok: false, message: fill(template.header_params
      ? (template.body_params === 1 ? msg("The template {name} needs {n} variable and a header variable (not supported in test sends).") : msg("The template {name} needs {n} variables and a header variable (not supported in test sends)."))
      : (template.body_params === 1 ? msg("The template {name} needs {n} variable.") : msg("The template {name} needs {n} variables.")), { name, n: template.body_params }) };
  }
  const to = toE164(profile[input.phoneProperty]);
  if (!to) return { ok: false, message: fill(msg("Not sent: no valid E.164 phone number in the {property} user property."), { property: input.phoneProperty }) };
  const w = await deliverMessage(db, creds, target, provider, {
    kind: "template", channel: "whatsapp", to, template: provider === "twilio" ? template.external_id ?? "" : name, language,
    bodyParams: input.whatsappParams.map((p) => p || "-"), headerParams: [], variableKeys: template.variables ?? [],
  });
  return { ok: w.ok, message: w.ok ? msg("Sent. WhatsApp accepted the message; delivery and read receipts arrive through the webhook.") : fill(msg("Not sent: {message}"), { message: String(w.error) }) };
}
