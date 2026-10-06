/**
 * Automation definitions: one trigger, ordered steps and guardrails. Pure,
 * validated with zod; stored as jsonb on automations and, per saved version,
 * on automation_versions. See docs/automation.md.
 */
import { z } from "zod";
import { describeNode, parseDefinition, type AudienceNode } from "@/modules/audiences/definition";
import { HHMM } from "./time";

const uuid = z.string().uuid("Choose an audience.");
const text = (max: number, what: string) => z.string().trim().min(1, `Enter ${what}.`).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const deepLink = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !v || /^[a-z][a-z0-9+.-]{1,30}:\/?\/?[^\s]*$/i.test(v), "Deep links look like myapp://path or https://…")
  .refine((v) => !/^(javascript|data|vbscript):/i.test(v), "That link scheme is not allowed.")
  .optional()
  .transform((v) => v || undefined);
const eventName = z.string().trim().min(1, "Choose an event.").max(200);
const propertyName = z.string().trim().regex(/^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$/, "Property names may use letters, digits, _ . $ - (max 64).");
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: eventName }),
  z.object({ type: z.literal("audience_entered"), audienceId: uuid }),
  z.object({ type: z.literal("audience_exited"), audienceId: uuid }),
  z.object({
    type: z.literal("schedule"),
    audienceId: uuid,
    every: z.enum(["day", "week"]),
    at: z.string().regex(HHMM, "Use HH:MM (24-hour)."),
    weekday: z.coerce.number().int().min(0).max(6).optional(),
  }),
]);
export type Trigger = z.infer<typeof triggerSchema>;

const condition = z.unknown().transform((v, ctx): AudienceNode => {
  try {
    return parseDefinition(v, { allowSinceTrigger: true });
  } catch (err) {
    ctx.addIssue({ code: "custom", message: `Branch condition: ${(err as Error).message}` });
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
  z.object({ type: z.literal("webhook"), webhookId: z.string().uuid("Choose a webhook.") }),
  z.object({ type: z.literal("push"), title: text(120, "a title"), body: text(500, "a message"), deepLink }),
  z.object({
    type: z.literal("in_app"), title: text(120, "a title"), body: text(1000, "a message"), buttonText: optionalText(40), deepLink,
    expiresInHours: z.coerce.number().int().min(1).max(720).default(72),
  }),
  z.object({
    type: z.literal("email"),
    /** A saved email template; when absent, `subject` and `body` are used. */
    templateId: z.string().uuid("Choose a template.").optional(),
    subject: optionalText(200),
    body: optionalText(20_000),
  }),
  z.object({
    type: z.literal("whatsapp"),
    /** An approved template synced from the WhatsApp Business account. */
    template: z.string().trim().min(1, "Choose a WhatsApp template.").max(512),
    language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Choose the template's language."),
    /** Values for {{1}}, {{2}}, … in the body (and header); may use {{user.x}} / {{event.x}}. */
    bodyParams: z.array(z.string().trim().min(1, "Fill in every template variable.").max(1024)).max(20).default([]),
    headerParams: z.array(z.string().trim().min(1, "Fill in every template variable.").max(60)).max(1).default([]),
    /** User property holding the phone number in E.164 (+9665…). */
    phoneProperty: propertyName.default("phone"),
  }),
  z.object({ type: z.literal("update_user_property"), property: propertyName, value: scalar }),
  z.object({
    type: z.literal("send_event"), event: eventName,
    properties: z.record(propertyName, scalar).refine((p) => Object.keys(p).length <= 20, "At most 20 properties.").default({}),
  }),
]);
export type Step = z.infer<typeof stepSchema>;
export const MESSAGE_STEPS = new Set<Step["type"]>(["push", "in_app", "email", "whatsapp"]);

export const definitionSchema = z
  .object({
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1, "Add at least one step.").max(50, "Use at most 50 steps."),
    /** Who may enter: once ever, or each trigger (never while a run is in progress) after a cooldown. */
    entry: z.object({ mode: z.enum(["once", "every_time"]), cooldownHours: z.coerce.number().int().min(0).max(8760).default(0) }).default({ mode: "every_time", cooldownHours: 0 }),
    /** Per-user cap over messages (push, in-app, email) from all automations of the environment. */
    frequencyCap: z.object({ messages: z.coerce.number().int().min(1).max(100), hours: z.coerce.number().int().min(1).max(720) }).nullable().default({ messages: 3, hours: 24 }),
    /** Push and email wait out these local hours (organization timezone). In-app messages are not affected. */
    quietHours: z.object({ start: z.string().regex(HHMM, "Use HH:MM."), end: z.string().regex(HHMM, "Use HH:MM.") }).nullable().default({ start: "22:00", end: "08:00" }),
  })
  .superRefine((d, ctx) => {
    d.steps.forEach((s, i) => {
      if (s.type === "email" && !s.templateId && (!s.subject || !s.body)) {
        ctx.addIssue({ code: "custom", path: ["steps", i], message: `Step ${i + 1}: choose an email template or write a subject and text.` });
      }
      if (s.type === "branch" && s.else !== "exit") {
        if (s.else.goto <= i) ctx.addIssue({ code: "custom", path: ["steps", i], message: `Step ${i + 1}: a branch can only jump forward.` });
        else if (s.else.goto >= d.steps.length) ctx.addIssue({ code: "custom", path: ["steps", i], message: `Step ${i + 1}: there is no step ${s.else.goto + 1}.` });
      }
    });
    if (d.trigger.type === "schedule" && d.trigger.every === "week" && d.trigger.weekday === undefined) {
      ctx.addIssue({ code: "custom", path: ["trigger"], message: "Choose a weekday for a weekly schedule." });
    }
  });
export type AutomationDefinition = z.infer<typeof definitionSchema>;

export class AutomationDefinitionError extends Error {}

export function parseAutomation(input: unknown): AutomationDefinition {
  const r = definitionSchema.safeParse(input);
  if (!r.success) {
    const custom = r.error.issues.find((i) => i.code === "custom");
    const issue = custom ?? r.error.issues[0];
    const where = issue?.path?.[0] === "steps" && typeof issue.path[1] === "number" && !custom ? `Step ${issue.path[1] + 1}: ` : "";
    throw new AutomationDefinitionError(`${where}${issue?.message ?? "The automation is not valid."}`);
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

export function describeStep(s: Step): string {
  switch (s.type) {
    case "delay": return `Wait ${s.amount} ${s.amount === 1 ? s.unit.slice(0, -1) : s.unit}`;
    case "branch": return `Continue if ${describeNode(s.condition)}, otherwise ${s.else === "exit" ? "exit" : `go to step ${s.else.goto + 1}`}`;
    case "webhook": return "Call webhook";
    case "push": return `Push: ${s.title}`;
    case "in_app": return `In-app message: ${s.title}`;
    case "email": return s.templateId ? "Email (template)" : `Email: ${s.subject}`;
    case "whatsapp": return `WhatsApp template: ${s.template} (${s.language})`;
    case "update_user_property": return `Set user property ${s.property} = ${JSON.stringify(s.value)}`;
    case "send_event": return `Send event ${s.event}`;
  }
}

export function describeTrigger(t: Trigger, audienceName: (id: string) => string = (id) => id): string {
  switch (t.type) {
    case "event": return `When someone does ${t.event}`;
    case "audience_entered": return `When someone enters ${audienceName(t.audienceId)}`;
    case "audience_exited": return `When someone leaves ${audienceName(t.audienceId)}`;
    case "schedule": {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      return `${t.every === "day" ? "Every day" : `Every ${days[t.weekday ?? 0]}`} at ${t.at} for everyone in ${audienceName(t.audienceId)}`;
    }
  }
}
