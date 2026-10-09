/**
 * Campaigns: Audience → Channel → Message → Schedule, stored as an automation
 * definition (one message step, a "once" or "schedule" trigger) so they run
 * on the automation engine with its guardrails: frequency cap, quiet hours,
 * consent and suppression, logs. This file turns the campaign form into that
 * definition and back. Pure.
 */
import { z } from "zod";
import { msg } from "@/i18n/translate";
import { AutomationDefinitionError, parseAutomation, type AutomationDefinition, type Step } from "@/modules/automation/definition";
import { localParts, zonedTime } from "@/modules/automation/time";
import { CHANNELS, SCHEDULES, type CampaignForm, type Channel } from "./options";

export { CHANNEL_LABELS, CHANNELS, SCHEDULES, type CampaignForm, type Channel, type ScheduleMode } from "./options";

export class CampaignError extends Error {}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const lines = (v: string | undefined) => (v ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

function messageStep(channel: Channel, f: CampaignForm): Step {
  switch (channel) {
    case "push":
      return { type: "push", title: f.title ?? "", body: f.body ?? "", deepLink: f.deepLink } as Step;
    case "in_app":
      return { type: "in_app", title: f.title ?? "", body: f.body ?? "", buttonText: f.buttonText, deepLink: f.deepLink, expiresInHours: 72 } as Step;
    case "email":
      return (f.emailTemplateId ? { type: "email", templateId: f.emailTemplateId } : { type: "email", subject: f.subject, body: f.body }) as Step;
    case "whatsapp": {
      const [template, language] = (f.whatsappTemplate ?? "").split("|");
      return { type: "whatsapp", template: template ?? "", language: language ?? "", bodyParams: lines(f.whatsappParams), headerParams: [], phoneProperty: f.phoneProperty || "phone" } as Step;
    }
  }
}

function trigger(f: CampaignForm, timezone: string, now: Date): AutomationDefinition["trigger"] {
  const audienceId = f.audienceId ?? "";
  const mode = SCHEDULES.find((m) => m === f.schedule) ?? "now";
  if (mode === "now") return { type: "once", audienceId, at: now.toISOString() };
  if (mode === "later") {
    const m = LOCAL_DATETIME.exec(f.sendAt ?? "");
    if (!m) throw new CampaignError(msg("Choose the date and time to send."));
    const at = zonedTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), timezone);
    if (at.getTime() < now.getTime() - 60_000) throw new CampaignError(msg("The send time has passed. Choose a later time, or Send now."));
    return { type: "once", audienceId, at: at.toISOString() };
  }
  return { type: "schedule", audienceId, every: mode === "daily" ? "day" : "week", at: f.time ?? "", weekday: mode === "weekly" ? Number(f.weekday ?? 0) : undefined };
}

/** The automation definition of a campaign; throws CampaignError with a message for the form. */
export function buildCampaign(f: CampaignForm, timezone: string, now = new Date()): AutomationDefinition {
  const channel = CHANNELS.find((c) => c === f.channel);
  if (!channel) throw new CampaignError(msg("Choose a channel."));
  if (!z.uuid().safeParse(f.audienceId).success) throw new CampaignError(msg("Choose an audience."));
  const cap = f.capMessages ? { messages: f.capMessages, hours: f.capHours || 24 } : null;
  try {
    return parseAutomation({
      trigger: trigger(f, timezone, now),
      steps: [messageStep(channel, f)],
      entry: { mode: "every_time", cooldownHours: 0 },
      frequencyCap: cap,
      quietHours: f.quietHours === "on" ? { start: "22:00", end: "08:00" } : null,
    });
  } catch (err) {
    if (err instanceof AutomationDefinitionError) throw new CampaignError(err.message.replace(/^Step 1: /, ""));
    throw err;
  }
}

export interface CampaignSummary {
  audienceId: string | null;
  channel: Channel | null;
  step: Step | null;
  schedule: { mode: "once"; at: string } | { mode: "daily" | "weekly"; at: string; weekday?: number } | null;
}

/** What a stored campaign definition says, for its page and edit form. */
export function campaignOf(d: AutomationDefinition): CampaignSummary {
  const step = d.steps.find((s) => (CHANNELS as readonly string[]).includes(s.type)) ?? null;
  const t = d.trigger;
  return {
    audienceId: "audienceId" in t ? t.audienceId : null,
    channel: (step?.type as Channel | undefined) ?? null,
    step,
    schedule: t.type === "once" ? { mode: "once", at: t.at } : t.type === "schedule" ? { mode: t.every === "day" ? "daily" : "weekly", at: t.at, weekday: t.weekday } : null,
  };
}

/** A local date-time input value (YYYY-MM-DDTHH:MM) for an instant in `timezone`. */
export function localInputValue(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "recurring" | "paused" | "cancelled";

/**
 * A campaign's status from its automation: a one-time send is scheduled until
 * its time, sending while runs are in progress, then sent. Recurring ones stay
 * "recurring" while active. Archived means cancelled.
 */
export function campaignStatus(a: { status: string; next_fire_at: Date | null; fired: boolean; runs: { active: number } ; definition: AutomationDefinition }): CampaignStatus {
  if (a.status === "draft") return "draft";
  if (a.status === "archived") return "cancelled";
  if (a.status === "paused") return "paused";
  if (a.definition.trigger.type !== "once") return "recurring";
  if (!a.fired) return a.next_fire_at && a.next_fire_at.getTime() > Date.now() ? "scheduled" : "sending";
  return Number(a.runs.active) > 0 ? "sending" : "sent";
}

/** The form values of a stored campaign, to edit it. */
export function formOf(d: AutomationDefinition, timezone: string, now = new Date()): CampaignForm {
  const c = campaignOf(d);
  const s = c.step;
  const f: CampaignForm = {
    audienceId: c.audienceId ?? undefined,
    channel: c.channel ?? undefined,
    capMessages: d.frequencyCap ? String(d.frequencyCap.messages) : undefined,
    capHours: d.frequencyCap ? String(d.frequencyCap.hours) : undefined,
    quietHours: d.quietHours ? "on" : undefined,
  };
  if (s?.type === "push" || s?.type === "in_app") Object.assign(f, { title: s.title, body: s.body, deepLink: s.deepLink, buttonText: s.type === "in_app" ? s.buttonText : undefined });
  if (s?.type === "email") Object.assign(f, { emailTemplateId: s.templateId, subject: s.subject, body: s.body });
  if (s?.type === "whatsapp") Object.assign(f, { whatsappTemplate: `${s.template}|${s.language}`, whatsappParams: s.bodyParams.join("\n"), phoneProperty: s.phoneProperty });
  // An unsent one-time campaign whose time has passed was (or now is) "Send now".
  if (c.schedule?.mode === "once") Object.assign(f, Date.parse(c.schedule.at) <= now.getTime() ? { schedule: "now" } : { schedule: "later", sendAt: localInputValue(new Date(c.schedule.at), timezone) });
  else if (c.schedule) Object.assign(f, { schedule: c.schedule.mode, time: c.schedule.at, weekday: c.schedule.weekday === undefined ? undefined : String(c.schedule.weekday) });
  return f;
}

/** Whether a one-time campaign is set for a time still ahead (so activating it schedules rather than sends). */
export function sendsLater(d: AutomationDefinition, now = new Date()): boolean {
  return d.trigger.type === "once" && Date.parse(d.trigger.at) > now.getTime();
}
