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

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: unknown[];
}

/** Highest {{n}} placeholder in a text (WhatsApp numbers them from 1). */
export function placeholderCount(text: string | undefined): number {
  let max = 0;
  for (const m of (text ?? "").matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function templateParams(components: TemplateComponent[]): { body: number; header: number } {
  const body = components.find((c) => c.type?.toUpperCase() === "BODY");
  const header = components.find((c) => c.type?.toUpperCase() === "HEADER" && (c.format ?? "TEXT").toUpperCase() === "TEXT");
  return { body: placeholderCount(body?.text), header: placeholderCount(header?.text) };
}

export interface TemplateSend {
  to: string; // E.164
  name: string;
  language: string;
  bodyParams: string[];
  headerParams?: string[];
}

/** Body for POST /{phone-number-id}/messages with an approved template. */
export function templateMessageBody(m: TemplateSend): Record<string, unknown> {
  const text = (v: string) => ({ type: "text", text: v.slice(0, 1024) });
  const components: Record<string, unknown>[] = [];
  if (m.headerParams?.length) components.push({ type: "header", parameters: m.headerParams.map(text) });
  if (m.bodyParams.length) components.push({ type: "body", parameters: m.bodyParams.map(text) });
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: waId(m.to),
    type: "template",
    template: { name: m.name, language: { code: m.language }, ...(components.length ? { components } : {}) },
  };
}

export function messagesUrl(base: string, version: string, phoneNumberId: string): string {
  return `${base}/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
}

export function templatesUrl(base: string, version: string, wabaId: string): string {
  return `${base}/${version}/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,category,components&limit=100`;
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
        messages?: { from?: string; type?: string; text?: { body?: string }; button?: { text?: string; payload?: string }; interactive?: { button_reply?: { title?: string } } }[];
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
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? null;
        batch.messages.push({ from: m.from, text });
      }
      out.push(batch);
    }
  }
  return out;
}
