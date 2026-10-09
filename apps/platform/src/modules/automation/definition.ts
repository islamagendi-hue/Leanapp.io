/**
 * Automation definitions: one trigger, ordered steps and guardrails. Pure,
 * validated with zod; stored as jsonb on automations and, per saved version,
 * on automation_versions. See docs/automation.md.
 */
import { z } from "zod";
import { makeT, msg, type T } from "@/i18n/translate";
import { describeNode, parseDefinition, type AudienceNode } from "@/modules/audiences/definition";
import { fill } from "./messages";
import { HHMM } from "./time";

const uuid = z.string().uuid(msg("Choose an audience."));
/** Required text; `missing` is the message when it is empty. */
const text = (max: number, missing: string) => z.string().trim().min(1, missing).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const deepLink = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !v || /^[a-z][a-z0-9+.-]{1,30}:\/?\/?[^\s]*$/i.test(v), msg("Deep links look like myapp://path or https://…"))
  .refine((v) => !/^(javascript|data|vbscript):/i.test(v), msg("That link scheme is not allowed."))
  .optional()
  .transform((v) => v || undefined);
/** A media library asset id (src/modules/media); checked against the app and channel when saved and sent. */
const imageAssetId = z.string().trim().optional().transform((v) => v || undefined).refine((v) => !v || z.uuid().safeParse(v).success, msg("Choose a file from the media library."));
const eventName = z.string().trim().min(1, msg("Choose an event.")).max(200);
const propertyName = z.string().trim().regex(/^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$/, msg("Property names may use letters, digits, _ . $ - (max 64)."));
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: eventName }),
  z.object({ type: z.literal("audience_entered"), audienceId: uuid }),
  z.object({ type: z.literal("audience_exited"), audienceId: uuid }),
  z.object({
    type: z.literal("schedule"),
    audienceId: uuid,
    every: z.enum(["day", "week"]),
    at: z.string().regex(HHMM, msg("Use HH:MM (24-hour).")),
    weekday: z.coerce.number().int().min(0).max(6).optional(),
  }),
  /** One send to everyone in an audience at `at` (or as soon as activated, if `at` has passed). Used by campaigns. */
  z.object({ type: z.literal("once"), audienceId: uuid, at: z.iso.datetime({ offset: true, message: msg("Choose when to send.") }) }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

const condition = z.unknown().transform((v, ctx): AudienceNode => {
  try {
    return parseDefinition(v, { allowSinceTrigger: true });
  } catch (err) {
    ctx.addIssue({ code: "custom", message: fill(msg("Branch condition: {message}"), { message: (err as Error).message }) });
    return z.NEVER;
  }
});

export const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delay"), amount: z.coerce.number().int().min(1).max(10_000), unit: z.enum(["minutes", "hours", "days"]) }),
  z.object({
    type: z.literal("branch"),
    condition,
    /** When the condition is false: end the run, or jump forward to step N (0-based). */
    else: z.union([z.literal("exit"), z.object({ goto: z.coerce.number().int().min(1).max(49) })]),
  }),
  z.object({ type: z.literal("webhook"), webhookId: z.string().uuid(msg("Choose a webhook.")) }),
  z.object({ type: z.literal("push"), title: text(120, msg("Enter a title.")), body: text(500, msg("Enter a message.")), deepLink, imageAssetId }),
  z.object({
    type: z.literal("in_app"), title: text(120, msg("Enter a title.")), body: text(1000, msg("Enter a message.")), buttonText: optionalText(40), deepLink, imageAssetId,
    expiresInHours: z.coerce.number().int().min(1).max(720).default(72),
  }),
  z.object({
    type: z.literal("email"),
    /** A saved email template; when absent, `subject` and `body` are used. */
    templateId: z.string().uuid(msg("Choose a template.")).optional(),
    subject: optionalText(200),
    body: optionalText(20_000),
  }),
  z.object({
    type: z.literal("whatsapp"),
    /** An approved template synced from the WhatsApp Business account. */
    template: z.string().trim().min(1, msg("Choose a WhatsApp template.")).max(512),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, msg("Choose the template's language.")),
    /** Values for {{1}}, {{2}}, … in the body (and header); may use {{user.x}} / {{event.x}}. */
    bodyParams: z.array(z.string().trim().min(1, msg("Fill in every template variable.")).max(1024)).max(20).default([]),
    headerParams: z.array(z.string().trim().min(1, msg("Fill in every template variable.")).max(60)).max(1).default([]),
    /** User property holding the phone number in E.164 (+9665…). */
    phoneProperty: propertyName.default("phone"),
  }),
  z.object({ type: z.literal("update_user_property"), property: propertyName, value: scalar }),
  /** Ends the run here (e.g. the end of a branch's "yes" path). */
  z.object({ type: z.literal("exit") }),
  z.object({
    type: z.literal("send_event"), event: eventName,
    properties: z.record(propertyName, scalar).refine((p) => Object.keys(p).length <= 20, msg("At most 20 properties.")).default({}),
  }),
]);
export type Step = z.infer<typeof stepSchema>;
export const MESSAGE_STEPS = new Set<Step["type"]>(["push", "in_app", "email", "whatsapp"]);

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1, msg("Add at least one step.")).max(50, msg("Use at most 50 steps.")),
    /** Who may enter: once ever, or each trigger (never while a run is in progress) after a cooldown. */
    entry: z.object({ mode: z.enum(["once", "every_time"]), cooldownHours: z.coerce.number().int().min(0).max(8760).default(0) }).default({ mode: "every_time", cooldownHours: 0 }),
    /** Per-user cap over messages (push, in-app, email) from all automations of the environment. */
    frequencyCap: z.object({ messages: z.coerce.number().int().min(1).max(100), hours: z.coerce.number().int().min(1).max(720) }).nullable().default({ messages: 3, hours: 24 }),
    /** Push and email wait out these local hours (organization timezone). In-app messages are not affected. */
    quietHours: z.object({ start: z.string().regex(HHMM, msg("Use HH:MM.")), end: z.string().regex(HHMM, msg("Use HH:MM.")) }).nullable().default({ start: "22:00", end: "08:00" }),
    /**
     * Conversion goal: the event that means the flow worked, done within
     * `withinDays` of the trigger. Reported per flow; with stopOnConversion
     * the run ends as soon as the person converts, so no more messages go out.
     */
    goal: z.object({ event: eventName, withinDays: z.coerce.number().int().min(1).max(90).default(7), stopOnConversion: z.boolean().default(true) }).nullable().default(null),
    /** Exit event: the run ends as soon as the person does this event after the trigger. */
    exitEvent: z.string().trim().max(200).nullable().default(null).transform((v) => v || null),
  })
  .superRefine((d, ctx) => {
    d.steps.forEach((s, i) => {
      if (s.type === "email" && !s.templateId && (!s.subject || !s.body)) {
        ctx.addIssue({ code: "custom", path: ["steps", i], message: fill(msg("Step {n}: choose an email template or write a subject and text."), { n: i + 1 }) });
      }
      if (s.type === "branch" && s.else !== "exit") {
        if (s.else.goto <= i) ctx.addIssue({ code: "custom", path: ["steps", i], message: fill(msg("Step {n}: a branch can only jump forward."), { n: i + 1 }) });
        else if (s.else.goto >= d.steps.length) ctx.addIssue({ code: "custom", path: ["steps", i], message: fill(msg("Step {n}: there is no step {target}."), { n: i + 1, target: s.else.goto + 1 }) });
      }
    });
    const triggerEvent = d.trigger.type === "event" ? d.trigger.event : null;
    if (d.goal && d.goal.event === triggerEvent) ctx.addIssue({ code: "custom", path: ["goal"], message: msg("The goal must be a different event from the trigger.") });
    if (d.exitEvent && d.exitEvent === triggerEvent) ctx.addIssue({ code: "custom", path: ["exitEvent"], message: msg("The exit event must be a different event from the trigger.") });
    if (d.trigger.type === "schedule" && d.trigger.every === "week" && d.trigger.weekday === undefined) {
      ctx.addIssue({ code: "custom", path: ["trigger"], message: msg("Choose a weekday for a weekly schedule.") });
    }
  });
export type AutomationDefinition = z.infer<typeof definitionSchema>;

export class AutomationDefinitionError extends Error {}

export function parseAutomation(input: unknown): AutomationDefinition {
  const r = definitionSchema.safeParse(input);
  if (!r.success) {
    const custom = r.error.issues.find((i) => i.code === "custom");
    const issue = custom ?? r.error.issues[0];
    const message = issue?.message ?? msg("The automation is not valid.");
    const step = issue?.path?.[0] === "steps" && typeof issue.path[1] === "number" && !custom ? issue.path[1] + 1 : null;
    throw new AutomationDefinitionError(step === null ? message : fill(msg("Step {n}: {message}"), { n: step, message }));
  }
  return r.data;
}

/** Audiences an automation depends on (to check they exist in the same environment). */
export function referencedAudiences(d: AutomationDefinition): string[] {
  return "audienceId" in d.trigger ? [d.trigger.audienceId] : [];
}

export function referencedWebhooks(d: AutomationDefinition): string[] {
  return d.steps.flatMap((s) => (s.type === "webhook" ? [s.webhookId] : []));
}

export function referencedEmailTemplates(d: AutomationDefinition): string[] {
  return d.steps.flatMap((s) => (s.type === "email" && s.templateId ? [s.templateId] : []));
}

export function referencedWhatsAppTemplates(d: AutomationDefinition): Extract<Step, { type: "whatsapp" }>[] {
  return d.steps.flatMap((s) => (s.type === "whatsapp" ? [s] : []));
}

/** Replaces {{user.x}} and {{event.x}} with values from the run; unknown keys become empty. */
export function renderTemplate(template: string, vars: { user?: Record<string, unknown>; event?: Record<string, unknown> }): string {
  return template.replace(/\{\{\s*(user|event)\.([A-Za-z0-9_.$-]{1,64})\s*\}\}/g, (_, scope: "user" | "event", key: string) => {
    const v = vars[scope]?.[key];
    return v === null || v === undefined || typeof v === "object" ? "" : String(v);
  });
}

const english = makeT(null);

const WAIT: Record<string, [string, string]> = {
  minutes: [msg("Wait 1 minute"), msg("Wait {n} minutes")],
  hours: [msg("Wait 1 hour"), msg("Wait {n} hours")],
  days: [msg("Wait 1 day"), msg("Wait {n} days")],
};

/** A readable line for a step, in English unless a translate function is given. */
export function describeStep(s: Step, t: T = english): string {
  switch (s.type) {
    case "delay": return t(WAIT[s.unit][s.amount === 1 ? 0 : 1], { n: s.amount });
    case "branch": {
      const condition = describeNode(s.condition, t);
      return s.else === "exit" ? t("Continue if {condition}, otherwise exit", { condition }) : t("Continue if {condition}, otherwise go to step {n}", { condition, n: s.else.goto + 1 });
    }
    case "webhook": return t("Call webhook");
    case "push": return t("Push: {title}", { title: s.title });
    case "in_app": return t("In-app message: {title}", { title: s.title });
    case "email": return s.templateId ? t("Email (template)") : t("Email: {subject}", { subject: String(s.subject) });
    case "whatsapp": return t("WhatsApp template: {template} ({language})", { template: s.template, language: s.language });
    case "update_user_property": return t("Set user property {property} = {value}", { property: s.property, value: JSON.stringify(s.value) });
    case "send_event": return t("Send event {event}", { event: s.event });
    case "exit": return t("Exit");
  }
}

const DAYS = [msg("Sunday"), msg("Monday"), msg("Tuesday"), msg("Wednesday"), msg("Thursday"), msg("Friday"), msg("Saturday")];

/** A readable line for a trigger, in English unless a translate function is given. */
export function describeTrigger(tr: Trigger, audienceName: (id: string) => string = (id) => id, t: T = english): string {
  switch (tr.type) {
    case "event": return t("When someone does {event}", { event: tr.event });
    case "audience_entered": return t("When someone enters {audience}", { audience: audienceName(tr.audienceId) });
    case "audience_exited": return t("When someone leaves {audience}", { audience: audienceName(tr.audienceId) });
    case "schedule": {
      const audience = audienceName(tr.audienceId);
      return tr.every === "day"
        ? t("Every day at {time} for everyone in {audience}", { time: tr.at, audience })
        : t("Every {weekday} at {time} for everyone in {audience}", { weekday: t(DAYS[tr.weekday ?? 0]), time: tr.at, audience });
    }
    case "once": return t("Once at {time} for everyone in {audience}", { time: tr.at, audience: audienceName(tr.audienceId) });
  }
}
