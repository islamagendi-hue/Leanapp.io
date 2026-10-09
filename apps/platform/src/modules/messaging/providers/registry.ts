/**
 * Messaging providers and what each one can do, per capability. Pure and
 * client-safe: the dashboard, the composer and the engine read the same
 * declarations. A capability is one of:
 *
 *   - implemented:        LeanApp calls it, through the adapter in this repo;
 *   - provider_supported: the provider's official docs document it, but
 *                         LeanApp doesn't call it yet;
 *   - unsupported:        the provider's docs say it doesn't exist;
 *   - unverified:         we couldn't confirm it from official docs, so it is
 *                         treated as not available (never assumed).
 *
 * Channels, data sources, providers, integration connections and provider
 * capabilities are separate things: a provider serves channels, a connection
 * (platform.integrations row) is one environment's credentials for a
 * provider, and each capability has its own status. See docs/messaging.md.
 */
import { msg } from "@/i18n/translate";

export const MESSAGING_CHANNELS = ["email", "sms", "push", "web_push", "in_app", "whatsapp"] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];
export const MESSAGING_CHANNEL_LABELS: Record<MessagingChannel, string> = {
  email: msg("Email"), sms: "SMS", push: msg("Mobile push"), web_push: msg("Web push"), in_app: msg("In-app"), whatsapp: "WhatsApp",
};

export const CAPABILITY_STATUSES = ["implemented", "provider_supported", "unsupported", "unverified"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITIES = [
  "connection_verify", "send_template", "send_session", "template_list", "template_create", "template_delete",
  "delivery_status", "inbound", "opt_out", "media",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  connection_verify: msg("Connection check"),
  send_template: msg("Send approved templates"),
  send_session: msg("Send free-form messages"),
  template_list: msg("Template discovery and sync"),
  template_create: msg("Create and submit templates"),
  template_delete: msg("Delete templates"),
  delivery_status: msg("Delivery status callbacks"),
  inbound: msg("Inbound messages and replies"),
  opt_out: msg("Opt-out handling"),
  media: msg("Media attachments"),
};

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

/** One kind of media a provider accepts on a channel, with the provider's own limits. */
export interface MediaRule {
  channel: MessagingChannel;
  kind: MediaKind;
  mimeTypes: readonly string[];
  maxBytes: number;
  /** Where the limit or restriction comes from, or a restriction to show (e.g. MMS countries). */
  note?: string;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  channels: readonly MessagingChannel[];
  /** Integration provider id in platform.integrations, when LeanApp can connect it. */
  integration: "fcm" | "apns" | "resend" | "whatsapp" | "twilio" | null;
  docsUrl: string;
  capabilities: Record<Capability, CapabilityStatus>;
  media: readonly MediaRule[];
  /** Short, factual notes (restrictions, what was confirmed). */
  notes: readonly string[];
}

const MB = 1024 * 1024;
const caps = (c: Partial<Record<Capability, CapabilityStatus>>): Record<Capability, CapabilityStatus> =>
  Object.fromEntries(CAPABILITIES.map((k) => [k, c[k] ?? "unverified"])) as Record<Capability, CapabilityStatus>;

/** Meta's documented media limits for the WhatsApp Cloud API (developers.facebook.com, "Supported media types"). */
export const WHATSAPP_MEDIA: readonly MediaRule[] = [
  { channel: "whatsapp", kind: "image", mimeTypes: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
  { channel: "whatsapp", kind: "video", mimeTypes: ["video/mp4", "video/3gpp"], maxBytes: 16 * MB },
  { channel: "whatsapp", kind: "audio", mimeTypes: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 16 * MB },
  { channel: "whatsapp", kind: "document", mimeTypes: ["application/pdf", "text/plain", "application/vnd.ms-excel", "application/msword", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], maxBytes: 100 * MB },
  { channel: "whatsapp", kind: "sticker", mimeTypes: ["image/webp"], maxBytes: 500 * 1024 },
];

export const MESSAGING_PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "whatsapp_cloud",
    name: "Meta WhatsApp Cloud API",
    channels: ["whatsapp"],
    integration: "whatsapp",
    docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    capabilities: caps({
      connection_verify: "implemented", send_template: "implemented", send_session: "implemented", template_list: "implemented",
      template_create: "implemented", template_delete: "implemented", delivery_status: "implemented", inbound: "implemented", opt_out: "implemented", media: "implemented",
    }),
    media: WHATSAPP_MEDIA,
    notes: [
      msg("Free-form messages only within 24 hours of the person's last message to you; otherwise an approved template is required."),
      msg("Template edits are made in WhatsApp Manager; LeanApp creates, submits and deletes templates."),
    ],
  },
  {
    id: "twilio",
    name: "Twilio",
    channels: ["sms", "whatsapp"],
    integration: "twilio",
    docsUrl: "https://www.twilio.com/docs/messaging/api/message-resource",
    capabilities: caps({
      connection_verify: "implemented", send_template: "implemented", send_session: "implemented", template_list: "implemented",
      template_create: "provider_supported", template_delete: "implemented", delivery_status: "implemented", inbound: "implemented", opt_out: "implemented", media: "implemented",
    }),
    media: [
      { channel: "sms", kind: "image", mimeTypes: ["image/jpeg", "image/png", "image/gif"], maxBytes: 5 * MB, note: msg("MMS: US and Canadian numbers only.") },
      ...WHATSAPP_MEDIA.filter((m) => m.kind !== "sticker"),
    ],
    notes: [
      msg("WhatsApp templates are Twilio Content templates (Content API) with WhatsApp approval; create them in the Twilio Console."),
      msg("SMS is text only; MMS images only to US and Canadian numbers."),
    ],
  },
  {
    id: "resend",
    name: "Resend",
    channels: ["email"],
    integration: "resend",
    docsUrl: "https://resend.com/docs/api-reference/emails/send-email",
    capabilities: caps({ connection_verify: "provider_supported", send_template: "unsupported", send_session: "implemented", template_list: "unsupported", template_create: "unsupported", template_delete: "unsupported", delivery_status: "provider_supported", inbound: "unsupported", opt_out: "implemented", media: "provider_supported" }),
    media: [],
    notes: [msg("Email templates are LeanApp templates; delivery and open events need a Resend webhook, which isn't connected yet.")],
  },
  {
    id: "fcm",
    name: "Firebase Cloud Messaging",
    channels: ["push"],
    integration: "fcm",
    docsUrl: "https://firebase.google.com/docs/cloud-messaging/send/v1-api",
    capabilities: caps({ connection_verify: "unverified", send_template: "unsupported", send_session: "implemented", template_list: "unsupported", template_create: "unsupported", template_delete: "unsupported", delivery_status: "unsupported", inbound: "unsupported", opt_out: "unsupported", media: "provider_supported" }),
    media: [],
    notes: [],
  },
  {
    id: "apns",
    name: "Apple Push Notification service",
    channels: ["push"],
    integration: "apns",
    docsUrl: "https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns",
    capabilities: caps({ connection_verify: "unverified", send_template: "unsupported", send_session: "implemented", template_list: "unsupported", template_create: "unsupported", template_delete: "unsupported", delivery_status: "unsupported", inbound: "unsupported", opt_out: "unsupported", media: "provider_supported" }),
    media: [],
    notes: [],
  },
  {
    id: "leanapp_in_app",
    name: "LeanApp in-app",
    channels: ["in_app"],
    integration: null,
    docsUrl: "https://leanapp.io/docs/sdk",
    capabilities: caps({ connection_verify: "unsupported", send_template: "unsupported", send_session: "implemented", template_list: "unsupported", template_create: "unsupported", template_delete: "unsupported", delivery_status: "implemented", inbound: "unsupported", opt_out: "unsupported", media: "unverified" }),
    media: [],
    notes: [],
  },
  // ── Descriptor only: confirmed from official docs, not built ───────────────
  {
    id: "360dialog",
    name: "360dialog",
    channels: ["whatsapp"],
    integration: null,
    docsUrl: "https://docs.360dialog.com/docs/waba-messaging/template-messaging",
    capabilities: caps({ send_template: "provider_supported", send_session: "provider_supported", template_list: "provider_supported", template_create: "provider_supported", template_delete: "provider_supported", delivery_status: "provider_supported", inbound: "provider_supported" }),
    media: [],
    notes: [msg("Documented: POST /messages and GET/POST/DELETE /v1/configs/templates on waba-v2.360dialog.io with a D360-API-KEY header. Not connected in LeanApp.")],
  },
  {
    id: "infobip",
    name: "Infobip",
    channels: ["whatsapp", "sms"],
    integration: null,
    docsUrl: "https://www.infobip.com/docs/whatsapp/api",
    capabilities: caps({ send_template: "provider_supported", template_create: "provider_supported", delivery_status: "provider_supported", inbound: "provider_supported" }),
    media: [],
    notes: [msg("Documented: template creation and sending, delivery and seen reports, inbound messages. Other operations weren't confirmed. Not connected in LeanApp.")],
  },
  {
    id: "gupshup",
    name: "Gupshup",
    channels: ["whatsapp"],
    integration: null,
    docsUrl: "https://docs.gupshup.io/docs/template-messages",
    capabilities: caps({ send_template: "provider_supported", template_list: "provider_supported", delivery_status: "provider_supported" }),
    media: [],
    notes: [msg("Documented: POST /wa/api/v1/template/msg, a template listing API and message event callbacks. Other operations weren't confirmed. Not connected in LeanApp.")],
  },
  {
    id: "wati",
    name: "WATI",
    channels: ["whatsapp"],
    integration: null,
    docsUrl: "https://docs.wati.io/reference/introduction",
    capabilities: caps({ send_template: "provider_supported", send_session: "provider_supported", template_list: "provider_supported", template_create: "provider_supported", template_delete: "provider_supported", inbound: "provider_supported" }),
    media: [],
    notes: [msg("Documented in WATI's API reference: get, create and delete templates, send template and session messages, webhooks. Not connected in LeanApp.")],
  },
  {
    id: "unifonic",
    name: "Unifonic",
    channels: ["whatsapp", "sms"],
    integration: null,
    docsUrl: "https://docs.unifonic.com/",
    capabilities: caps({}),
    media: [],
    notes: [msg("Unifonic documents WhatsApp and SMS products, but we couldn't confirm specific API operations from its public docs, so every capability is marked unverified.")],
  },
  {
    id: "respond_io",
    name: "respond.io",
    channels: ["whatsapp"],
    integration: null,
    docsUrl: "https://developers.respond.io/",
    capabilities: caps({}),
    media: [],
    notes: [msg("We couldn't confirm respond.io's API operations from its public docs, so every capability is marked unverified.")],
  },
];

export function messagingProvider(id: string): ProviderDescriptor | null {
  return MESSAGING_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * The media a provider accepts on a channel, in the media library's
 * capability shape (`ProviderMediaSupport`), so its channel check uses the
 * provider's own limits. Stickers are WhatsApp-only and not offered.
 */
export function providerMediaSupport(providerId: string, channel: MessagingChannel): { kind: "image" | "video" | "document" | "audio"; mimeTypes: string[]; maxBytes: number }[] {
  return (messagingProvider(providerId)?.media ?? [])
    .filter((r) => r.channel === channel && r.kind !== "sticker")
    .map((r) => ({ kind: r.kind as "image" | "video" | "document" | "audio", mimeTypes: [...r.mimeTypes], maxBytes: r.maxBytes }));
}

export function providersForChannel(channel: MessagingChannel): ProviderDescriptor[] {
  return MESSAGING_PROVIDERS.filter((p) => p.channels.includes(channel));
}

/** Whether LeanApp can do this with the provider today. */
export function can(providerId: string, capability: Capability): boolean {
  return messagingProvider(providerId)?.capabilities[capability] === "implemented";
}

/** WhatsApp providers LeanApp can send through, by the integration that connects them. */
export const WHATSAPP_PROVIDERS = ["whatsapp_cloud", "twilio"] as const;
export type WhatsAppProvider = (typeof WHATSAPP_PROVIDERS)[number];
export const PROVIDER_OF_INTEGRATION: Record<string, string> = { whatsapp: "whatsapp_cloud", twilio: "twilio", resend: "resend", fcm: "fcm", apns: "apns" };
