"use server";

import { msg } from "@/i18n/translate";
import { log } from "@/lib/log";
import { sendEmail } from "@/modules/email/service";
import { DEMO_LOCKED, isDemoUser } from "@/modules/marketing/demo";
import { SUPPORT_EMAIL } from "@/modules/support/contact";
import type { ActionState } from "@/server/action-result";
import { requireTenant, requireUser } from "@/server/session";

const TOPICS = ["question", "problem", "billing", "feature"] as const;

/** Sends a member's message to the support inbox, with who sent it and from where. */
export async function contactSupportAction(orgSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (isDemoUser(user)) return { error: DEMO_LOCKED };
  const ctx = await requireTenant(orgSlug);
  const topic = TOPICS.find((x) => x === form.get("topic")) ?? "question";
  const subject = String(form.get("subject") ?? "").trim().slice(0, 150);
  const message = String(form.get("message") ?? "").trim().slice(0, 5000);
  const fieldErrors: Record<string, string> = {};
  if (subject.length < 3) fieldErrors.subject = msg("Write a short subject.");
  if (message.length < 10) fieldErrors.message = msg("Tell us a little more, so we can help.");
  if (Object.keys(fieldErrors).length) return { fieldErrors };

  const result = await sendEmail({
    to: SUPPORT_EMAIL,
    kind: "support_request",
    subject: `[${topic}] ${subject}`,
    text: [
      `From: ${user.name} <${user.email}>`,
      `Organization: ${ctx.organizationName} (/o/${ctx.organizationSlug}), role ${ctx.role}`,
      `Page: ${String(form.get("page") ?? "").slice(0, 300) || "-"}`,
      "",
      message,
    ].join("\n"),
  });
  if (!result.delivered) {
    log.error("support.not_sent", { org: ctx.organizationSlug, transport: result.transport, error: result.error });
    return { error: msg("We couldn't send your message. Please email us instead.") };
  }
  return { ok: true, message: msg("Sent. We reply by email, usually within one working day.") };
}
