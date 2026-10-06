import "server-only";
import { log } from "@/lib/log";

/**
 * Transactional email. One transport is chosen from the environment:
 *
 * - `RESEND_API_KEY` + `EMAIL_FROM` set → Resend (https://resend.com) over HTTPS.
 * - otherwise, outside production → "log": printed to the server log and kept in
 *   an in-memory outbox (used by tests and local development).
 * - otherwise (production without a provider) → "disabled": nothing is sent and
 *   callers get `delivered: false`, so the UI can say so instead of pretending.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Tag for logs and provider analytics, e.g. "password_reset". */
  kind: string;
}

export interface SendResult {
  delivered: boolean;
  transport: "resend" | "log" | "disabled";
  id?: string;
  error?: string;
}

export type EmailTransport = SendResult["transport"];

/** Messages captured by the log transport. Tests read and clear it. */
export const outbox: EmailMessage[] = [];

export function emailTransport(): EmailTransport {
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) return "resend";
  return process.env.NODE_ENV === "production" ? "disabled" : "log";
}

export function emailConfigured(): boolean {
  return emailTransport() !== "disabled";
}

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const transport = emailTransport();
  if (transport === "log") {
    outbox.push(msg);
    if (process.env.NODE_ENV !== "test") console.info(`[email:${msg.kind}] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
    return { delivered: true, transport };
  }
  if (transport === "disabled") {
    log.warn("email.not_sent", { kind: msg.kind, reason: "no email provider configured (set RESEND_API_KEY and EMAIL_FROM)" });
    return { delivered: false, transport };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html ?? textToHtml(msg.text),
        tags: [{ name: "kind", value: msg.kind }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const error = `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      log.error("email.failed", { kind: msg.kind, error });
      return { delivered: false, transport, error };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { delivered: true, transport, id: body.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("email.failed", { kind: msg.kind, error });
    return { delivered: false, transport, error };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain, accessible HTML from the text body: paragraphs and clickable links. */
export function textToHtml(text: string): string {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px">${escapeHtml(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0e1311;max-width:560px">${paras}<p style="margin:24px 0 0;color:#777;font-size:13px">LeanApp · leanapp.io</p></div>`;
}
