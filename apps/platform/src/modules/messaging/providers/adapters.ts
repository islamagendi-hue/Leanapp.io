import "server-only";
import type { DeliveryCredentials } from "@/modules/messaging/integrations";
import { sendTwilio, verifyTwilio } from "@/modules/twilio/service";
import { sendSession, sendTemplate, verifyWhatsApp } from "@/modules/whatsapp/service";
import { can, messagingProvider, type MessagingChannel } from "./registry";

/**
 * The adapter layer: one interface over every provider LeanApp sends
 * through. Campaigns, flows and test sends build an OutboundMessage and call
 * `send`; the adapter turns it into the provider's request. What a provider
 * can do is declared in ./registry.ts and checked here before any call, so
 * an unsupported operation fails with a reason instead of being attempted.
 */

export type OutboundMessage =
  | {
      kind: "template";
      channel: "whatsapp";
      to: string; // E.164
      /** Meta: template name; Twilio: the Content SID (external_id). */
      template: string;
      language: string;
      bodyParams: string[];
      headerParams: string[];
      /** Variable keys in send order (header first), for named templates and Twilio ContentVariables. */
      variableKeys: string[];
      headerMedia?: { kind: "image" | "video" | "document"; link: string };
    }
  | {
      kind: "text";
      channel: "whatsapp" | "sms";
      to: string; // E.164
      text: string;
      media?: { kind: "image" | "video" | "audio" | "document"; link: string };
    };

export interface SendOutcome {
  ok: boolean;
  messageId: string | null;
  error: string | null;
  optedOut: boolean;
  live: boolean;
  /** The integration used (for markIntegration), or null when none is connected. */
  integrationId: string | null;
}

export interface MessagingAdapter {
  id: "whatsapp_cloud" | "twilio";
  channels: readonly MessagingChannel[];
  send(creds: DeliveryCredentials, m: OutboundMessage): Promise<SendOutcome>;
  verify(creds: DeliveryCredentials): Promise<{ ok: boolean; detail: string; live: boolean; config?: Record<string, string> } | null>;
}

const notConnected = (name: string, unreadable: boolean): SendOutcome => ({
  ok: false, messageId: null, error: unreadable ? `${name} credentials can't be read` : `${name} is not connected`, optedOut: false, live: false, integrationId: null,
});

const whatsappCloud: MessagingAdapter = {
  id: "whatsapp_cloud",
  channels: ["whatsapp"],
  async send(creds, m) {
    if (!creds.whatsapp) return notConnected("WhatsApp", Boolean(creds.errors.whatsapp));
    const c = creds.whatsapp.creds;
    if (m.channel !== "whatsapp") return { ...notConnected("WhatsApp", false), error: "The WhatsApp Cloud API only sends WhatsApp messages.", integrationId: creds.whatsapp.id };
    let r;
    if (m.kind === "template") {
      const named = m.variableKeys.some((k) => !/^\d+$/.test(k));
      const headerNames = named ? m.variableKeys.slice(0, m.headerParams.length) : undefined;
      const bodyNames = named ? m.variableKeys.slice(m.headerParams.length) : undefined;
      r = await sendTemplate(c, { to: m.to, name: m.template, language: m.language, bodyParams: m.bodyParams, headerParams: m.headerParams, bodyNames, headerNames, headerMedia: m.headerMedia });
    } else {
      r = await sendSession(c, { to: m.to, text: m.text, media: m.media });
    }
    return { ...r, integrationId: creds.whatsapp.id };
  },
  async verify(creds) {
    if (!creds.whatsapp) return null;
    const r = await verifyWhatsApp(creds.whatsapp.creds);
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.info)) if (typeof v === "string" && v) config[k] = v.slice(0, 120);
    return { ok: r.ok, detail: r.detail, live: r.live, config };
  },
};

const twilio: MessagingAdapter = {
  id: "twilio",
  channels: ["sms", "whatsapp"],
  async send(creds, m) {
    if (!creds.twilio) return notConnected("Twilio", Boolean(creds.errors.twilio));
    const { id, creds: c } = creds.twilio;
    let r;
    if (m.kind === "template") {
      const vars: Record<string, string> = {};
      [...m.headerParams, ...m.bodyParams].forEach((v, i) => (vars[m.variableKeys[i] ?? String(i + 1)] = v));
      r = await sendTwilio(c, id, { channel: "whatsapp", to: m.to, contentSid: m.template, contentVariables: vars, mediaUrls: m.headerMedia ? [m.headerMedia.link] : undefined });
    } else {
      r = await sendTwilio(c, id, { channel: m.channel, to: m.to, body: m.text, mediaUrls: m.media ? [m.media.link] : undefined });
    }
    return { ...r, integrationId: id };
  },
  async verify(creds) {
    if (!creds.twilio) return null;
    return verifyTwilio(creds.twilio.creds);
  },
};

export const ADAPTERS: Record<MessagingAdapter["id"], MessagingAdapter> = { whatsapp_cloud: whatsappCloud, twilio };

export function adapterFor(providerId: string): MessagingAdapter | null {
  return (ADAPTERS as Record<string, MessagingAdapter>)[providerId] ?? null;
}

/** Sends through the provider after checking its declared capabilities for this kind of message. */
export async function sendThrough(providerId: string, creds: DeliveryCredentials, m: OutboundMessage): Promise<SendOutcome> {
  const adapter = adapterFor(providerId);
  const provider = messagingProvider(providerId);
  const refuse = (error: string): SendOutcome => ({ ok: false, messageId: null, error, optedOut: false, live: false, integrationId: null });
  if (!adapter || !provider) return refuse(`No adapter for provider ${providerId}.`);
  if (!adapter.channels.includes(m.channel)) return refuse(`${provider.name} doesn't send ${m.channel}.`);
  if (m.kind === "template" && !can(providerId, "send_template")) return refuse(`${provider.name} template sending isn't available.`);
  if (m.kind === "text" && !can(providerId, "send_session")) return refuse(`${provider.name} free-form sending isn't available.`);
  if ((m.kind === "text" ? m.media : m.headerMedia) && !can(providerId, "media")) return refuse(`${provider.name} media sending isn't available.`);
  return adapter.send(creds, m);
}

