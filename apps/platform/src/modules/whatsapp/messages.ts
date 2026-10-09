/**
 * WhatsApp Business Cloud API (Meta Graph API): pure request building,
 * signature verification and webhook parsing. No I/O; see transport in
 * ./service.ts. Docs: docs/messaging.md.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const GRAPH_HOST = "https://graph.facebook.com";
/** Graph API version used for every call; override with WHATSAPP_GRAPH_VERSION. */
export const DEFAULT_GRAPH_VERSION = "v23.0";

/** E.164: "+" then 8 to 15 digits, no leading zero in the country code. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/** Normalizes a phone user property to E.164, or null when it isn't one (spaces, dashes, dots and brackets are ignored). */
export function toE164(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().replace(/[\s().-]/g, "");
  const v = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
  return E164.test(v) ? v : null;
}

/** WhatsApp ids are the E.164 number without "+". */
export const waId = (e164: string) => e164.replace(/^\+/, "");

export { placeholderCount, placeholderKeys, renderTemplateText, templateParams, templateVariables, type TemplateComponent, type TemplateVariables } from "./template-text";
import { placeholderCount } from "./template-text";

export interface HeaderMedia {
  kind: "image" | "video" | "document";
  link: string;
}

export interface TemplateSend {
  to: string; // E.164
  name: string;
  language: string;
  bodyParams: string[];
  headerParams?: string[];
  /** For NAMED templates: the variable names, in the same order as the params. */
  bodyNames?: string[];
  headerNames?: string[];
  headerMedia?: HeaderMedia;
}

/** Body for POST /{phone-number-id}/messages with an approved template. */
export function templateMessageBody(m: TemplateSend): Record<string, unknown> {
  const text = (names: string[] | undefined) => (v: string, i: number) => ({ type: "text", ...(names?.[i] ? { parameter_name: names[i] } : {}), text: v.slice(0, 1024) });
  const components: Record<string, unknown>[] = [];
  if (m.headerMedia) components.push({ type: "header", parameters: [{ type: m.headerMedia.kind, [m.headerMedia.kind]: { link: m.headerMedia.link } }] });
  else if (m.headerParams?.length) components.push({ type: "header", parameters: m.headerParams.map(text(m.headerNames)) });
  if (m.bodyParams.length) components.push({ type: "body", parameters: m.bodyParams.map(text(m.bodyNames)) });
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: waId(m.to),
    type: "template",
    template: { name: m.name, language: { code: m.language }, ...(components.length ? { components } : {}) },
  };
}

export interface SessionSend {
  to: string; // E.164
  text?: string;
  media?: { kind: "image" | "video" | "audio" | "document"; link: string };
}

/** Body for a free-form (session) message: text, or media with the text as caption (audio takes no caption). */
export function sessionMessageBody(m: SessionSend): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: waId(m.to) };
  if (m.media) {
    const caption = m.text && m.media.kind !== "audio" ? { caption: m.text.slice(0, 1024) } : {};
    return { ...base, type: m.media.kind, [m.media.kind]: { link: m.media.link, ...caption } };
  }
  return { ...base, type: "text", text: { preview_url: false, body: (m.text ?? "").slice(0, 4096) } };
}

/** The customer service window: free-form messages only within 24 hours of the person's last message. */
export const SESSION_WINDOW_MS = 24 * 3_600_000;
export function sessionOpen(lastInboundAt: Date | string | null | undefined, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - new Date(lastInboundAt).getTime() < SESSION_WINDOW_MS;
}

export interface TemplateDraft {
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  headerText?: string | null;
  body: string;
  footer?: string | null;
  examples: string[];
}

/** Body for POST /{waba-id}/message_templates (positional variables, with the example values Meta reviews). */
export function templateCreateBody(d: TemplateDraft): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  if (d.headerText) components.push({ type: "HEADER", format: "TEXT", text: d.headerText });
  const n = placeholderCount(d.body);
  components.push({ type: "BODY", text: d.body, ...(n ? { example: { body_text: [d.examples.slice(0, n)] } } : {}) });
  if (d.footer) components.push({ type: "FOOTER", text: d.footer });
  return { name: d.name, language: d.language, category: d.category, components };
}

export function messagesUrl(base: string, version: string, phoneNumberId: string): string {
  return `${base}/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
}

export function templatesUrl(base: string, version: string, wabaId: string): string {
  return `${base}/${version}/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,components,rejected_reason,quality_score&limit=100`;
}

export function templateCreateUrl(base: string, version: string, wabaId: string): string {
  return `${base}/${version}/${encodeURIComponent(wabaId)}/message_templates`;
}

/** DELETE by name (every language), or one language version with hsm_id (the template id). */
export function templateDeleteUrl(base: string, version: string, wabaId: string, name: string, templateId?: string | null): string {
  const q = new URLSearchParams({ name, ...(templateId ? { hsm_id: templateId } : {}) });
  return `${base}/${version}/${encodeURIComponent(wabaId)}/message_templates?${q}`;
}

/** The phone number's details, to check the connection and show what is connected. */
export function phoneNumberUrl(base: string, version: string, phoneNumberId: string): string {
  return `${base}/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`;
}

/**
 * What a Graph API error code means for the person fixing it, from Meta's
 * WhatsApp Cloud API error codes reference. Unknown codes return null.
 */
export function explainGraphError(code: number | null): string | null {
  switch (code) {
    case 190: return "The access token is invalid or expired. Create a permanent system-user token and reconnect.";
    case 10:
    case 200:
    case 294: return "The access token lacks a permission. It needs whatsapp_business_management (templates) and whatsapp_business_messaging (sending).";
    case 100: return "WhatsApp rejected a parameter. Check the phone number ID, WhatsApp Business Account ID and template.";
    case 131047: return "More than 24 hours have passed since the person last messaged you. Use an approved template.";
    case 132000: return "The number of template variables doesn't match the template.";
    case 132001: return "The template doesn't exist in this language, or isn't approved.";
    case 131026: return "The message couldn't be delivered to this number (not on WhatsApp, or an old app version).";
    case 131050: return "The person stopped marketing messages from businesses.";
    case 133010: return "The phone number isn't registered with the Cloud API.";
    default: return null;
  }
}

/** Error codes meaning the person opted out of marketing messages from businesses (suppress them). */
export const OPT_OUT_ERROR_CODES = new Set([131050]);

export interface GraphError {
  code: number | null;
  message: string;
}

export function graphError(status: number, body: string): GraphError {
  try {
    const e = (JSON.parse(body) as { error?: { code?: number; message?: string; error_data?: { details?: string } } }).error;
    if (e) return { code: typeof e.code === "number" ? e.code : null, message: `${e.code ?? status}: ${(e.error_data?.details ?? e.message ?? "error").slice(0, 200)}` };
  } catch {
    /* not JSON */
  }
  return { code: null, message: `HTTP ${status}` };
}

/** X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
export function hubSignature(appSecret: string, rawBody: string | Buffer): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifyHubSignature(appSecret: string, header: string | null, rawBody: string | Buffer): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(hubSignature(appSecret, rawBody));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Opt-out keywords (case-insensitive, whole message): English and Arabic.
 * Meta's "Stop promotions" quick-reply button is also an opt-out.
 */
const OPT_OUT = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "stop promotions", "إيقاف", "ايقاف", "توقف", "الغاء", "إلغاء", "الغاء الاشتراك", "إلغاء الاشتراك"]);

export function isOptOut(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.normalize("NFC").trim().toLowerCase().replace(/[.!؟?]+$/u, "").replace(/\s+/g, " ");
  return OPT_OUT.has(t);
}

export interface StatusUpdate {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient: string;
  errorCode: number | null;
  error: string | null;
}

export interface InboundMessage {
  from: string;
  text: string | null;
  id?: string;
  type?: string;
  /** Unix seconds, as sent by WhatsApp. */
  timestamp?: number;
}

export interface WebhookBatch {
  phoneNumberId: string;
  statuses: StatusUpdate[];
  messages: InboundMessage[];
}

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

/** Parses a Cloud API webhook notification into status updates and inbound texts, per phone number. */
export function parseWebhook(payload: unknown): WebhookBatch[] {
  const out: WebhookBatch[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of ((entry as { changes?: unknown[] })?.changes ?? []) as { field?: string; value?: Record<string, unknown> }[]) {
      if (change?.field !== "messages" || !change.value) continue;
      const v = change.value as {
        metadata?: { phone_number_id?: string };
        statuses?: { id?: string; status?: string; recipient_id?: string; errors?: { code?: number; title?: string; message?: string }[] }[];
        messages?: {
          id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string; payload?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }; image?: { caption?: string };
        }[];
      };
      const batch: WebhookBatch = { phoneNumberId: String(v.metadata?.phone_number_id ?? ""), statuses: [], messages: [] };
      for (const s of v.statuses ?? []) {
        if (!s?.id || !STATUSES.has(String(s.status))) continue;
        const e = s.errors?.[0];
        batch.statuses.push({
          messageId: s.id, status: s.status as StatusUpdate["status"], recipient: String(s.recipient_id ?? ""),
          errorCode: typeof e?.code === "number" ? e.code : null, error: e ? `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim().slice(0, 200) : null,
        });
      }
      for (const m of v.messages ?? []) {
        if (!m?.from) continue;
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.image?.caption ?? null;
        const ts = Number(m.timestamp);
        batch.messages.push({ from: m.from, text, ...(m.id ? { id: m.id } : {}), type: String(m.type ?? "text"), ...(Number.isFinite(ts) && ts > 0 ? { timestamp: ts } : {}) });
      }
      out.push(batch);
    }
  }
  return out;
}
