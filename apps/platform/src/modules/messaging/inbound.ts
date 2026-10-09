import "server-only";
import type { Db } from "@/lib/db";
import { recordUnsubscribe } from "./consent";
import { sha256 } from "./integrations";

/**
 * Inbound messages (replies) from WhatsApp and SMS, whatever the provider.
 * The sender's number is never stored: it is hashed with the environment
 * (the same hash as notifications.recipient_hash), which finds the person we
 * last messaged at that number. Each inbound message:
 *   - is stored once (deduplicated by the provider's message id);
 *   - opens or extends the customer service window (WhatsApp: 24 hours);
 *   - when it is an opt-out, adds a suppression for the channel;
 *   - can trigger flows (trigger type `inbound_message`).
 */

/** sha256 of environment and number (digits only), as stored on notifications and inbound messages. */
export const senderHash = (environmentId: string, number: string) => sha256(`${environmentId}:${number.replace(/^(whatsapp:)?\+?/, "")}`);

export interface Inbound {
  organizationId: string;
  environmentId: string;
  integrationId: string;
  provider: "whatsapp_cloud" | "twilio";
  channel: "whatsapp" | "sms";
  providerMessageId: string | null;
  /** E.164 number or WhatsApp id (digits). */
  from: string;
  body: string | null;
  type: string;
  receivedAt: Date;
  optOut: boolean;
  optOutReason: string;
}

export interface InboundResult {
  stored: boolean;
  userKey: string | null;
  optedOut: boolean;
}

export async function recordInbound(db: Db, m: Inbound): Promise<InboundResult> {
  const hash = senderHash(m.environmentId, m.from);
  const person = await db.one<{ user_key: string }>(
    `select user_key from platform.notifications where environment_id = $1 and channel = $2 and recipient_hash = $3 order by created_at desc limit 1`,
    [m.environmentId, m.channel, hash],
  );
  const userKey = person?.user_key ?? null;
  const row = await db.one<{ id: string }>(
    `insert into platform.inbound_messages (organization_id, environment_id, integration_id, provider, channel, provider_message_id, sender_hash, user_key, message_type, body, opt_out, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (environment_id, provider, provider_message_id) where provider_message_id is not null do nothing returning id`,
    [m.organizationId, m.environmentId, m.integrationId, m.provider, m.channel, m.providerMessageId, hash, userKey, m.type.slice(0, 40), m.body?.slice(0, 4096) ?? null, m.optOut, m.receivedAt],
  );
  if (!row) return { stored: false, userKey, optedOut: false };
  await db.query(
    `insert into platform.messaging_sessions (organization_id, environment_id, channel, sender_hash, user_key, last_inbound_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (environment_id, channel, sender_hash) do update
       set last_inbound_at = greatest(platform.messaging_sessions.last_inbound_at, excluded.last_inbound_at),
           user_key = coalesce(excluded.user_key, platform.messaging_sessions.user_key)`,
    [m.organizationId, m.environmentId, m.channel, hash, userKey, m.receivedAt],
  );
  let optedOut = false;
  if (m.optOut && userKey) {
    optedOut = await recordUnsubscribe(db, { organizationId: m.organizationId, environmentId: m.environmentId, userKey, channel: m.channel, reason: m.optOutReason });
  }
  return { stored: true, userKey, optedOut };
}

/** When the person last messaged on the channel (for the 24-hour window), by their number. */
export async function lastInboundAt(db: Db, environmentId: string, channel: "whatsapp" | "sms", number: string): Promise<Date | null> {
  const row = await db.one<{ last_inbound_at: Date }>(
    "select last_inbound_at from platform.messaging_sessions where environment_id = $1 and channel = $2 and sender_hash = $3",
    [environmentId, channel, senderHash(environmentId, number)],
  );
  return row?.last_inbound_at ?? null;
}
