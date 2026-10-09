/**
 * Twilio Programmable Messaging (SMS, MMS, WhatsApp) and the Content API
 * (WhatsApp templates): pure request building, X-Twilio-Signature checking
 * and callback parsing. No I/O; see ./service.ts. Docs: docs/messaging.md.
 *
 * Official references:
 *   - Messages: POST /2010-04-01/Accounts/{AccountSid}/Messages.json
 *     (https://www.twilio.com/docs/messaging/api/message-resource)
 *   - Content templates with WhatsApp approval: GET /v1/ContentAndApprovals,
 *     DELETE /v1/Content/{ContentSid} (https://www.twilio.com/docs/content)
 *   - Webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TWILIO_API = "https://api.twilio.com";
export const TWILIO_CONTENT_API = "https://content.twilio.com";

export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
export const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/;
export const CONTENT_SID = /^HX[0-9a-f]{32}$/;

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Sender for SMS: a Messaging Service (preferred) or an E.164 number. */
  messagingServiceSid: string | null;
  fromNumber: string | null;
  /** WhatsApp sender (E.164) registered on the account, or null when WhatsApp isn't used through Twilio. */
  whatsappFrom: string | null;
}

export const basicAuth = (c: Pick<TwilioCredentials, "accountSid" | "authToken">) => `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`;

export function messagesUrl(base: string, accountSid: string): string {
  return `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

export function accountUrl(base: string, accountSid: string): string {
  return `${base}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`;
}

export function contentListUrl(base: string): string {
  return `${base}/v1/ContentAndApprovals?PageSize=100`;
}

export function contentUrl(base: string, contentSid: string): string {
  return `${base}/v1/Content/${encodeURIComponent(contentSid)}`;
}

export interface TwilioSend {
  channel: "sms" | "whatsapp";
  to: string; // E.164
  body?: string;
  mediaUrls?: string[];
  /** WhatsApp template: a Content SID and its variables ({"1": "Sara"}). */
  contentSid?: string;
  contentVariables?: Record<string, string>;
  statusCallback: string;
}

/** Form fields for the Messages resource. WhatsApp addresses are prefixed with "whatsapp:". */
export function messageForm(c: TwilioCredentials, m: TwilioSend): URLSearchParams {
  const f = new URLSearchParams();
  const wa = m.channel === "whatsapp";
  f.set("To", wa ? `whatsapp:${m.to}` : m.to);
  if (wa) f.set("From", `whatsapp:${c.whatsappFrom ?? ""}`);
  else if (c.messagingServiceSid) f.set("MessagingServiceSid", c.messagingServiceSid);
  else f.set("From", c.fromNumber ?? "");
  if (m.contentSid) {
    f.set("ContentSid", m.contentSid);
    if (m.contentVariables && Object.keys(m.contentVariables).length) f.set("ContentVariables", JSON.stringify(m.contentVariables));
  } else if (m.body !== undefined) {
    f.set("Body", m.body.slice(0, 1600));
  }
  for (const u of m.mediaUrls ?? []) f.append("MediaUrl", u);
  f.set("StatusCallback", m.statusCallback);
  return f;
}

/**
 * X-Twilio-Signature: base64 HMAC-SHA1, keyed with the auth token, of the
 * full callback URL followed by every POST parameter name and value, sorted
 * by name.
 */
export function twilioSignature(authToken: string, url: string, params: URLSearchParams | Record<string, string>): string {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  const data = url + entries.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a < b ? -1 : 1)).map(([k, v]) => k + v).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioSignature(authToken: string, header: string | null, url: string, params: URLSearchParams): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header.trim());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface TwilioError {
  code: number | null;
  message: string;
}

export function twilioError(status: number, body: string): TwilioError {
  try {
    const e = JSON.parse(body) as { code?: number; message?: string };
    if (e && (e.code || e.message)) return { code: typeof e.code === "number" ? e.code : null, message: `${e.code ?? status}: ${(e.message ?? "error").slice(0, 200)}` };
  } catch {
    /* not JSON */
  }
  return { code: null, message: `HTTP ${status}` };
}

/** Error codes meaning the recipient opted out (21610: replied STOP to this sender). */
export const TWILIO_OPT_OUT_CODES = new Set([21610]);

/** What a Twilio error code means, from Twilio's error dictionary. Unknown codes return null. */
export function explainTwilioError(code: number | null): string | null {
  switch (code) {
    case 20003: return "Twilio rejected the Account SID or auth token.";
    case 21211: return "The phone number isn't a valid number.";
    case 21408: return "The Twilio account isn't allowed to send SMS to this country (Geo Permissions).";
    case 21606: return "The From number can't send this kind of message.";
    case 21610: return "The person replied STOP to this sender, so Twilio won't deliver to them.";
    case 21614: return "The number can't receive SMS.";
    case 63016: return "More than 24 hours have passed since the person last messaged you on WhatsApp. Use an approved template.";
    default: return null;
  }
}

/** Twilio message statuses, mapped onto the notification statuses LeanApp stores. */
const STATUS_MAP: Record<string, "sent" | "delivered" | "read" | "failed" | null> = {
  accepted: null, scheduled: null, queued: null, sending: null, sent: "sent", delivered: "delivered", read: "read", undelivered: "failed", failed: "failed", canceled: "failed",
};

export type TwilioCallback =
  | { kind: "status"; messageSid: string; status: "sent" | "delivered" | "read" | "failed"; errorCode: number | null; error: string | null }
  | { kind: "inbound"; messageSid: string; channel: "sms" | "whatsapp"; from: string; to: string; body: string | null; optOutType: string | null; numMedia: number }
  | { kind: "ignored" };

const stripWa = (v: string) => v.replace(/^whatsapp:/, "");

/** A status callback (has MessageStatus) or an inbound message (no MessageStatus), from the form-encoded callback. */
export function parseTwilioCallback(p: URLSearchParams): TwilioCallback {
  const sid = p.get("MessageSid") ?? p.get("SmsSid") ?? "";
  if (!/^(SM|MM)[0-9a-f]{32}$/.test(sid)) return { kind: "ignored" };
  const status = p.get("MessageStatus");
  if (status) {
    const mapped = STATUS_MAP[status];
    if (!mapped) return { kind: "ignored" };
    const code = Number(p.get("ErrorCode"));
    const errorCode = Number.isFinite(code) && code > 0 ? code : null;
    return { kind: "status", messageSid: sid, status: mapped, errorCode, error: errorCode ? `Twilio ${errorCode}${explainTwilioError(errorCode) ? `: ${explainTwilioError(errorCode)}` : ""}` : null };
  }
  const from = p.get("From") ?? "";
  if (!from) return { kind: "ignored" };
  return {
    kind: "inbound",
    messageSid: sid,
    channel: from.startsWith("whatsapp:") ? "whatsapp" : "sms",
    from: stripWa(from),
    to: stripWa(p.get("To") ?? ""),
    body: p.get("Body"),
    optOutType: p.get("OptOutType"),
    numMedia: Number(p.get("NumMedia") ?? 0) || 0,
  };
}

export interface ContentTemplate {
  sid: string;
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  body: string | null;
  /** Variable keys ("1", "2" …) with their sample values. */
  variables: Record<string, string>;
  /** Media header kind when the content is twilio/media, else null. */
  mediaHeader: boolean;
}

/** Reads one entry of GET /v1/ContentAndApprovals into what LeanApp stores. Unapproved-for-WhatsApp content gets status UNSUBMITTED. */
export function parseContent(c: unknown): ContentTemplate | null {
  const x = c as {
    sid?: string; friendly_name?: string; language?: string; variables?: Record<string, string>; types?: Record<string, { body?: string }>;
    approval_requests?: { name?: string; status?: string; category?: string; rejection_reason?: string } | null;
  };
  if (!x?.sid || !CONTENT_SID.test(x.sid)) return null;
  const types = x.types ?? {};
  const body = Object.values(types).find((t) => typeof t?.body === "string")?.body ?? null;
  const a = x.approval_requests ?? null;
  return {
    sid: x.sid,
    name: (a?.name || x.friendly_name || x.sid).slice(0, 512),
    language: (x.language ?? "en").slice(0, 20),
    status: (a?.status || "unsubmitted").toUpperCase(),
    category: a?.category ? a.category.toUpperCase() : null,
    rejectedReason: a?.rejection_reason || null,
    body,
    variables: x.variables && typeof x.variables === "object" ? x.variables : {},
    mediaHeader: "twilio/media" in types,
  };
}
