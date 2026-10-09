"use client";

import { useState } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { OUTCOME_LABELS, OUTCOMES } from "@/modules/automation/definition";
import { flowNodes, insertStep, moveStep, removeStep } from "@/modules/automation/flow";
import { messagingProvider, WHATSAPP_PROVIDERS } from "@/modules/messaging/providers/registry";
import { smsSegments } from "@/modules/messaging/variables";
import { ConditionBuilder, ParsedInput, parseValue, type Json, type PropertyLists } from "./ConditionBuilder";

type Step = Json & { type: string };
type Definition = {
  trigger: Json & { type: string };
  steps: Step[];
  entry: { mode: string; cooldownHours: number };
  frequencyCap: { messages: number; hours: number } | null;
  quietHours: { start: string; end: string } | null;
  goal?: { event: string; withinDays: number; stopOnConversion: boolean } | null;
  exitEvent?: string | null;
};

/** Node kinds offered in the builder; "condition" and "branch" are both branch steps (else exit / else jump). */
const STEP_TYPES: [string, string][] = [
  ["delay", msg("Wait")],
  ["condition", msg("Condition: continue only if")],
  ["branch", msg("Branch: if / otherwise")],
  ["push", msg("Push notification")],
  ["in_app", msg("In-app message")],
  ["email", msg("Email")],
  ["whatsapp", msg("WhatsApp template")],
  ["whatsapp_session", msg("WhatsApp message (24-hour window)")],
  ["sms", msg("SMS")],
  ["wait_outcome", msg("Wait for delivery outcome")],
  ["webhook", msg("Webhook")],
  ["update_user_property", msg("Update user property")],
  ["send_event", msg("Send event")],
  ["exit", msg("Exit")],
];
const KIND: Record<string, { label: string; tone: string }> = {
  delay: { label: msg("Wait"), tone: "border-s-ink-3" },
  condition: { label: msg("Condition"), tone: "border-s-warn" },
  branch: { label: msg("Branch"), tone: "border-s-warn" },
  push: { label: msg("Message"), tone: "border-s-accent" },
  in_app: { label: msg("Message"), tone: "border-s-accent" },
  email: { label: msg("Message"), tone: "border-s-accent" },
  whatsapp: { label: msg("Message"), tone: "border-s-accent" },
  whatsapp_session: { label: msg("Message"), tone: "border-s-accent" },
  sms: { label: msg("Message"), tone: "border-s-accent" },
  wait_outcome: { label: msg("Wait"), tone: "border-s-warn" },
  webhook: { label: msg("Action"), tone: "border-s-line-strong" },
  update_user_property: { label: msg("Action"), tone: "border-s-line-strong" },
  send_event: { label: msg("Action"), tone: "border-s-line-strong" },
  exit: { label: msg("Exit"), tone: "border-s-alert" },
};
const kindOf = (s: Step) => (s.type === "branch" ? (s.else === "exit" ? "condition" : "branch") : s.type);
const WEEKDAYS = [msg("Sunday"), msg("Monday"), msg("Tuesday"), msg("Wednesday"), msg("Thursday"), msg("Friday"), msg("Saturday")];

/** A new step of `type` placed at index `at` of a flow with `total` steps (after insertion). */
function defaultStep(type: string, at = 0, total = 1): Step {
  const condition = { type: "event", event: "", did: false, countOp: "gte", count: 1, withinDays: 30, where: [], sinceTrigger: true };
  switch (type) {
    case "delay": return { type, amount: 1, unit: "hours" };
    case "condition": return { type: "branch", condition, else: "exit" };
    case "branch": return { type, condition, else: at + 2 < total ? { goto: at + 2 } : "exit" };
    case "exit": return { type };
    case "push": return { type, title: "", body: "" };
    case "in_app": return { type, title: "", body: "", expiresInHours: 72 };
    case "email": return { type, subject: "", body: "" };
    case "whatsapp": return { type, template: "", language: "", bodyParams: [], headerParams: [], phoneProperty: "phone", provider: "whatsapp_cloud" };
    case "whatsapp_session": return { type, text: "", phoneProperty: "phone", provider: "whatsapp_cloud" };
    case "sms": return { type, text: "", phoneProperty: "phone", provider: "twilio" };
    case "wait_outcome": return { type, step: Math.max(0, at - 1), outcome: "delivered", withinHours: 24, else: "exit" };
    case "webhook": return { type, webhookId: "" };
    case "update_user_property": return { type, property: "", value: "" };
    default: return { type: "send_event", event: "", properties: {} };
  }
}

export const DEFAULT_DEFINITION: Definition = {
  trigger: { type: "event", event: "" },
  steps: [{ type: "delay", amount: 1, unit: "hours" }],
  entry: { mode: "every_time", cooldownHours: 0 },
  frequencyCap: { messages: 3, hours: 24 },
  quietHours: { start: "22:00", end: "08:00" },
  goal: null,
  exitEvent: null,
};

export interface WhatsAppTemplateOption { name: string; language: string; status: string; body_params: number; header_params: number; body_text: string | null; provider?: string; header_format?: string | null }
export interface EmailTemplateOption { id: string; name: string; subject: string }
type Channels = { whatsappTemplates: WhatsAppTemplateOption[]; emailTemplates: EmailTemplateOption[] };

export function AutomationEditor({
  save, initial, name, events, properties, audiences, webhooks, timezone, whatsappTemplates = [], emailTemplates = [],
}: Partial<Channels> & {
  save: (state: FormState, form: FormData) => Promise<FormState>;
  initial: Definition;
  name: string;
  events: string[];
  properties?: PropertyLists;
  audiences: { id: string; name: string; status: string }[];
  webhooks: { id: string; url: string; description: string | null }[];
  timezone: string;
}) {
  const [d, setD] = useState<Definition>(initial);
  const set = (patch: Partial<Definition>) => setD({ ...d, ...patch });
  const setStep = (i: number, s: Step) => set({ steps: d.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, by: number) => set({ steps: moveStep(d.steps, i, i + by) });
  const insert = (at: number, type: string) => set({ steps: insertStep(d.steps, at, defaultStep(type, at, d.steps.length + 1)) });
  const nodes = flowNodes(d.steps);
  const t = useT();
  const tg = d.trigger;
  const audienceSelect = (
    <select className="input w-auto" value={String(tg.audienceId ?? "")} onChange={(e) => set({ trigger: { ...tg, audienceId: e.target.value } })} aria-label={t("Audience")}>
      <option value="">{t("Choose an audience")}</option>
      {audiences.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== "active" ? ` (${t(a.status)})` : ""}</option>)}
    </select>
  );

  return (
    <ActionForm action={save} submitLabel={t("Save")} className="space-y-6">
      <input type="hidden" name="definition" value={JSON.stringify(d)} />
      <datalist id="automation-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <label className="block max-w-md"><span className="label">{t("Name")}</span><input name="name" className="input" defaultValue={name} required maxLength={80} /></label>

      <fieldset className="space-y-2 rounded-lg border border-line border-s-4 border-s-ink bg-card p-4" data-step="trigger">
        <legend className="px-1 text-sm font-bold">{t("Trigger")}</legend>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" value={tg.type} onChange={(e) => {
            const type = e.target.value;
            set({ trigger: type === "event" ? { type, event: "" } : type === "schedule" ? { type, audienceId: tg.audienceId ?? "", every: "day", at: "10:00" } : type === "inbound_message" ? { type, channel: "whatsapp" } : { type, audienceId: tg.audienceId ?? "" } });
          }}>
            <option value="event">{t("When someone does an event")}</option>
            <option value="audience_entered">{t("When someone enters an audience")}</option>
            <option value="audience_exited">{t("When someone leaves an audience")}</option>
            <option value="schedule">{t("On a schedule, for an audience")}</option>
            <option value="inbound_message">{t("When someone replies on WhatsApp or SMS")}</option>
          </select>
          {tg.type === "event" && <input className="input w-60" list="automation-events" placeholder={t("event name")} value={String(tg.event ?? "")} onChange={(e) => set({ trigger: { ...tg, event: e.target.value } })} aria-label={t("Event")} dir="ltr" />}
          {tg.type !== "event" && tg.type !== "inbound_message" && audienceSelect}
          {tg.type === "inbound_message" && (
            <>
              <select className="input w-auto" value={String(tg.channel ?? "whatsapp")} onChange={(e) => set({ trigger: { ...tg, channel: e.target.value } })} aria-label={t("Channel")}>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">{t("SMS")}</option>
              </select>
              <input className="input w-44" maxLength={100} placeholder={t("keyword (optional)")} value={String(tg.keyword ?? "")} onChange={(e) => set({ trigger: { ...tg, keyword: e.target.value || undefined } })} aria-label={t("Keyword")} dir="auto" />
            </>
          )}
          {tg.type === "schedule" && (
            <>
              <select className="input w-auto" value={String(tg.every)} onChange={(e) => set({ trigger: { ...tg, every: e.target.value, weekday: e.target.value === "week" ? (tg.weekday ?? 0) : undefined } })}>
                <option value="day">{t("every day")}</option>
                <option value="week">{t("every week on")}</option>
              </select>
              {tg.every === "week" && (
                <select className="input w-auto" value={String(tg.weekday ?? 0)} onChange={(e) => set({ trigger: { ...tg, weekday: Number(e.target.value) } })}>
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{t(w)}</option>)}
                </select>
              )}
              <span>{t("at")}</span>
              <input className="input w-28" type="time" value={String(tg.at ?? "10:00")} onChange={(e) => set({ trigger: { ...tg, at: e.target.value } })} aria-label={t("Time")} />
              <span className="text-ink-3">({timezone})</span>
            </>
          )}
        </div>
        <p className="help">{t("Only events and audience changes after activation start runs. Events sent by automations never trigger automations.")}</p>
      </fieldset>

      <fieldset className="space-y-0" aria-label={t("Flow")}>
        <legend className="sr-only">{t("Steps")}</legend>
        <ol className="space-y-0">
          {d.steps.map((s, i) => {
            const k = kindOf(s);
            const n = nodes[i];
            return (
              <li key={i}>
                <Connector onInsert={d.steps.length < 50 ? (type) => insert(i, type) : undefined} />
                <div className={`space-y-2 rounded-lg border border-line border-s-4 bg-card p-3 ${KIND[k]?.tone ?? ""}`} data-step={k}>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-ink-3">{i + 1}.</span>
                    <span className="pill border-line text-xs">{KIND[k] ? t(KIND[k].label) : k}</span>
                    <select className="input w-auto" value={k} onChange={(e) => setStep(i, defaultStep(e.target.value, i, d.steps.length))} aria-label={t("Step {n} type", { n: i + 1 })}>
                      {STEP_TYPES.map(([key, l]) => <option key={key} value={key}>{t(l)}</option>)}
                    </select>
                    <span className="ms-auto flex gap-2 text-xs">
                      {i > 0 && <button type="button" className="hover:underline" onClick={() => move(i, -1)} aria-label={t("Move step {n} up", { n: i + 1 })}>↑</button>}
                      {i < d.steps.length - 1 && <button type="button" className="hover:underline" onClick={() => move(i, 1)} aria-label={t("Move step {n} down", { n: i + 1 })}>↓</button>}
                      {d.steps.length > 1 && <button type="button" className="text-alert hover:underline" onClick={() => set({ steps: removeStep(d.steps, i) })}>{t("Remove")}</button>}
                    </span>
                  </div>
                  <StepFields step={s} index={i} total={d.steps.length} onChange={(x) => setStep(i, x)} events={events} properties={properties} webhooks={webhooks} whatsappTemplates={whatsappTemplates} emailTemplates={emailTemplates} />
                  {(s.type === "branch" || s.type === "wait_outcome") && (
                    <p className="flex flex-wrap gap-2 text-xs">
                      <span className="pill border-accent/40 text-accent-ink">{i + 2 <= d.steps.length ? t("Yes → step {n}", { n: i + 2 }) : t("Yes → step end")}</span>
                      <span className={`pill ${n.broken ? "border-alert/40 text-alert" : "border-warn/40 text-warn"}`}>{n.no === "exit" ? t("No → exit") : n.broken ? t("No → step {n} (must be a later step)", { n: String(n.no) }) : t("No → step {n}", { n: String(n.no) })}</span>
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <Connector onInsert={d.steps.length < 50 ? (type) => insert(d.steps.length, type) : undefined} />
        <div className="rounded-lg border border-dashed border-line px-3 py-2 text-center text-sm text-ink-3">{t("End of flow")}</div>
        <p className="help mt-2">{t("Text can use {user} and {event} (the trigger event). A branch's “yes” path runs into the next steps; end it with Exit when the “no” path follows.", { user: "{{user.<property>}}", event: "{{event.<property>}}" })}</p>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-line p-4 md:grid-cols-2">
        <legend className="px-1 text-sm font-bold">{t("Goal and exit")}</legend>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={Boolean(d.goal)} onChange={(e) => set({ goal: e.target.checked ? { event: "", withinDays: 7, stopOnConversion: true } : null })} /> {t("Conversion goal")}</label>
          {d.goal && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {t("The person does")}
                <input className="input w-52" list="automation-events" placeholder={t("event name")} value={d.goal.event} onChange={(e) => set({ goal: { ...d.goal!, event: e.target.value } })} aria-label={t("Goal event")} dir="ltr" />
                {t("within")}
                <input className="input w-20" type="number" min={1} max={90} value={d.goal.withinDays} onChange={(e) => set({ goal: { ...d.goal!, withinDays: Number(e.target.value) } })} aria-label={t("Goal window (days)")} /> {t("days")}
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={d.goal.stopOnConversion} onChange={(e) => set({ goal: { ...d.goal!, stopOnConversion: e.target.checked } })} /> {t("Stop the flow for people who converted")}</label>
            </div>
          )}
          <p className="help">{t("Counted from the trigger. The flow's page reports how many people converted.")}</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.exitEvent !== null && d.exitEvent !== undefined} onChange={(e) => set({ exitEvent: e.target.checked ? "" : null })} /> {t("Exit event")}</label>
          {d.exitEvent !== null && d.exitEvent !== undefined && (
            <input className="input w-60" list="automation-events" placeholder={t("event name")} value={d.exitEvent} onChange={(e) => set({ exitEvent: e.target.value })} aria-label={t("Exit event")} dir="ltr" />
          )}
          <p className="help">{t("When the person does this event after the trigger, their run ends before the next step, e.g. an order placed during a cart reminder flow.")}</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-line p-4 md:grid-cols-3">
        <legend className="px-1 text-sm font-bold">{t("Guardrails")}</legend>
        <div className="space-y-2 text-sm">
          <p className="label">{t("Entry")}</p>
          <select className="input" value={d.entry.mode} onChange={(e) => set({ entry: { ...d.entry, mode: e.target.value } })}>
            <option value="every_time">{t("Each time triggered")}</option>
            <option value="once">{t("Once per person, ever")}</option>
          </select>
          {d.entry.mode === "every_time" && (
            <label className="flex items-center gap-2">{t("at most every")} <input className="input w-20" type="number" min={0} value={d.entry.cooldownHours} onChange={(e) => set({ entry: { ...d.entry, cooldownHours: Number(e.target.value) } })} /> {t("h")}</label>
          )}
          <p className="help">{t("Never while the person already has a run in progress.")}</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.frequencyCap !== null} onChange={(e) => set({ frequencyCap: e.target.checked ? { messages: 3, hours: 24 } : null })} /> {t("Frequency cap")}</label>
          {d.frequencyCap && (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-16" type="number" min={1} max={100} value={d.frequencyCap.messages} onChange={(e) => set({ frequencyCap: { ...d.frequencyCap!, messages: Number(e.target.value) } })} />
              {t("messages per")}
              <input className="input w-20" type="number" min={1} max={720} value={d.frequencyCap.hours} onChange={(e) => set({ frequencyCap: { ...d.frequencyCap!, hours: Number(e.target.value) } })} /> {t("h")}
            </div>
          )}
          <p className="help">{t("Counts push, email, WhatsApp, SMS and in-app messages to the person from all automations here; over the cap, the message is skipped.")}</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.quietHours !== null} onChange={(e) => set({ quietHours: e.target.checked ? { start: "22:00", end: "08:00" } : null })} /> {t("Quiet hours")}</label>
          {d.quietHours && (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-28" type="time" value={d.quietHours.start} onChange={(e) => set({ quietHours: { ...d.quietHours!, start: e.target.value } })} />–
              <input className="input w-28" type="time" value={d.quietHours.end} onChange={(e) => set({ quietHours: { ...d.quietHours!, end: e.target.value } })} />
            </div>
          )}
          <p className="help">{t("Push, email, WhatsApp and SMS wait until quiet hours end ({timezone}, the organization's timezone).", { timezone })}</p>
        </div>
      </fieldset>
    </ActionForm>
  );
}

function StepFields({ step: s, index, total, onChange, events, properties, webhooks, whatsappTemplates, emailTemplates }: Channels & {
  step: Step; index: number; total: number; onChange: (s: Step) => void; events: string[]; properties?: PropertyLists;
  webhooks: { id: string; url: string; description: string | null }[];
}) {
  const t = useT();
  const text = (k: string, label: string, max: number, area = false) => (
    <label className="block text-sm"><span className="label">{t(label)}</span>
      {area
        ? <textarea className="input min-h-24 py-2" maxLength={max} value={String(s[k] ?? "")} onChange={(e) => onChange({ ...s, [k]: e.target.value })} />
        : <input className="input" maxLength={max} value={String(s[k] ?? "")} onChange={(e) => onChange({ ...s, [k]: e.target.value || (k === "deepLink" || k === "buttonText" ? undefined : "") })} />}
    </label>
  );
  const providerSelect = (providers: readonly string[], set: (p: string) => void) => (
    <label className="block"><span className="label">{t("Provider")}</span>
      <select className="input" value={String(s.provider ?? providers[0])} onChange={(e) => set(e.target.value)}>
        {providers.map((p) => <option key={p} value={p}>{messagingProvider(p)?.name ?? p}</option>)}
      </select>
    </label>
  );
  // MERGE: replace with <MediaPicker name="mediaAssetId" channel=… /> from the media library (workstream D).
  const mediaField = (label: string) => (
    <label className="block text-sm"><span className="label">{t(label)}</span>
      <input className="input font-mono" dir="ltr" maxLength={36} placeholder="00000000-0000-0000-0000-000000000000" value={String(s.mediaAssetId ?? "")} onChange={(e) => onChange({ ...s, mediaAssetId: e.target.value.trim() || undefined })} />
    </label>
  );
  switch (s.type) {
    case "exit":
      return <p className="text-sm text-ink-2">{t("The run ends here.")}</p>;
    case "delay":
      return (
        <div className="flex items-center gap-2 text-sm">
          <input className="input w-24" type="number" min={1} value={Number(s.amount)} onChange={(e) => onChange({ ...s, amount: Number(e.target.value) })} aria-label={t("Amount")} />
          <select className="input w-auto" value={String(s.unit)} onChange={(e) => onChange({ ...s, unit: e.target.value })} aria-label={t("Unit")}>
            <option value="minutes">{t("minutes")}</option><option value="hours">{t("hours")}</option><option value="days">{t("days")}</option>
          </select>
        </div>
      );
    case "branch": {
      const elseValue = s.else === "exit" ? "exit" : String((s.else as { goto: number }).goto);
      return (
        <div className="space-y-2 text-sm">
          <p>{t("Continue if the person matches:")}</p>
          <ConditionBuilder value={s.condition as Step} onChange={(c) => onChange({ ...s, condition: c })} events={events} properties={properties} allowSinceTrigger />
          <label className="flex flex-wrap items-center gap-2">{t("Otherwise")}
            <select className="input w-auto" value={elseValue} onChange={(e) => onChange({ ...s, else: e.target.value === "exit" ? "exit" : { goto: Number(e.target.value) } })}>
              <option value="exit">{t("end the run")}</option>
              {Array.from({ length: total }, (_, j) => j).filter((j) => j > index + 1).map((j) => <option key={j} value={j}>{t("skip to step {n}", { n: j + 1 })}</option>)}
            </select>
          </label>
        </div>
      );
    }
    case "push":
      return <div className="grid gap-2 md:grid-cols-2">{text("title", msg("Title"), 120)}{text("deepLink", msg("Deep link (optional)"), 500)}<div className="md:col-span-2">{text("body", msg("Message"), 500, true)}</div></div>;
    case "in_app":
      return (
        <div className="grid gap-2 md:grid-cols-2">
          {text("title", msg("Title"), 120)}{text("buttonText", msg("Button (optional)"), 40)}
          <div className="md:col-span-2">{text("body", msg("Message"), 1000, true)}</div>
          {text("deepLink", msg("Button link (optional)"), 500)}
          <label className="block text-sm"><span className="label">{t("Expires after (hours)")}</span><input className="input" type="number" min={1} max={720} value={Number(s.expiresInHours ?? 72)} onChange={(e) => onChange({ ...s, expiresInHours: Number(e.target.value) })} /></label>
        </div>
      );
    case "email": {
      const templateId = String(s.templateId ?? "");
      return (
        <div className="space-y-2">
          <label className="block text-sm"><span className="label">{t("Content")}</span>
            <select className="input" value={templateId} onChange={(e) => onChange(e.target.value ? { type: "email", templateId: e.target.value } : { type: "email", subject: "", body: "" })}>
              <option value="">{t("Write it here")}</option>
              {emailTemplates.map((e) => <option key={e.id} value={e.id}>{t("Template: {name}", { name: e.name })}</option>)}
            </select>
          </label>
          {!templateId && <>{text("subject", msg("Subject"), 200)}{text("body", msg("Text"), 20_000, true)}</>}
          <p className="help">{t("Sent to the person's {email} user property through your Resend account, with an unsubscribe link. Skipped for people who unsubscribed or denied marketing consent.", { email: "email" })}</p>
        </div>
      );
    }
    case "whatsapp": {
      const provider = String(s.provider ?? "whatsapp_cloud");
      const options = whatsappTemplates.filter((w) => (w.provider ?? "whatsapp_cloud") === provider);
      const key = s.template ? `${String(s.template)}|${String(s.language)}` : "";
      const tpl = options.find((w) => `${w.name}|${w.language}` === key);
      const mediaHeader = Boolean(tpl?.header_format && tpl.header_format !== "TEXT");
      const params = (k: "bodyParams" | "headerParams") => (Array.isArray(s[k]) ? (s[k] as string[]) : []);
      const setParam = (k: "bodyParams" | "headerParams", j: number, v: string) => {
        const next = [...params(k)];
        next[j] = v;
        onChange({ ...s, [k]: next });
      };
      return (
        <div className="space-y-2 text-sm">
          <div className="grid gap-2 md:grid-cols-2">
            {providerSelect(WHATSAPP_PROVIDERS, (p) => onChange({ ...s, provider: p, template: "", language: "", bodyParams: [], headerParams: [], mediaAssetId: undefined }))}
            <label className="block"><span className="label">{t("Approved template")}</span>
              <select className="input" value={key} onChange={(e) => {
                const w = options.find((x) => `${x.name}|${x.language}` === e.target.value);
                onChange({ ...s, template: w?.name ?? "", language: w?.language ?? "", bodyParams: Array(w?.body_params ?? 0).fill(""), headerParams: Array(w?.header_params ?? 0).fill(""), mediaAssetId: undefined });
              }}>
                <option value="">{options.length ? t("Choose a template") : t("No templates synced (Engage → Integrations)")}</option>
                {options.map((w) => <option key={`${w.name}|${w.language}`} value={`${w.name}|${w.language}`} disabled={w.status !== "APPROVED"}>{w.name} ({w.language}){w.status !== "APPROVED" ? ` · ${w.status.toLowerCase()}` : ""}</option>)}
              </select>
            </label>
            <label className="block"><span className="label">{t("Phone number user property (E.164)")}</span>
              <input className="input font-mono" value={String(s.phoneProperty ?? "phone")} onChange={(e) => onChange({ ...s, phoneProperty: e.target.value })} />
            </label>
          </div>
          {tpl?.body_text && <p className="whitespace-pre-wrap rounded-lg bg-paper-2 p-2 text-ink-2">{tpl.body_text}</p>}
          {mediaHeader && mediaField(msg("Header media asset ID"))}
          {params("headerParams").map((v, j) => (
            <label key={`h${j}`} className="block"><span className="label">{t("Header {variable}", { variable: `{{${j + 1}}}` })}</span><input className="input" maxLength={60} value={v} onChange={(e) => setParam("headerParams", j, e.target.value)} /></label>
          ))}
          {params("bodyParams").map((v, j) => (
            <label key={`b${j}`} className="block"><span className="label">{t("Body {variable}", { variable: `{{${j + 1}}}` })}</span><input className="input" maxLength={1024} placeholder="{{user.name}}" value={v} onChange={(e) => setParam("bodyParams", j, e.target.value)} /></label>
          ))}
          <p className="help">{t("Only templates approved by WhatsApp can be sent. Skipped for people without a valid number, who denied marketing consent, or who replied STOP.")}</p>
        </div>
      );
    }
    case "whatsapp_session":
    case "sms":
      return (
        <div className="space-y-2 text-sm">
          <div className="grid gap-2 md:grid-cols-2">
            {s.type === "whatsapp_session"
              ? providerSelect(WHATSAPP_PROVIDERS, (p) => onChange({ ...s, provider: p }))
              : <p className="self-end text-ink-2">{t("Sent through Twilio.")}</p>}
            <label className="block"><span className="label">{t("Phone number user property (E.164)")}</span>
              <input className="input font-mono" value={String(s.phoneProperty ?? "phone")} onChange={(e) => onChange({ ...s, phoneProperty: e.target.value })} />
            </label>
          </div>
          {text("text", msg("Message"), s.type === "sms" ? 1600 : 4096, true)}
          {s.type === "sms" && <p className="help">{t("{n} SMS segment(s)", { n: smsSegments(String(s.text ?? "")).segments })}</p>}
          {mediaField(s.type === "sms" ? msg("Image asset ID (MMS, US and Canada numbers only)") : msg("Media asset ID (optional)"))}
          <p className="help">{s.type === "sms"
            ? t("Skipped for people without a valid number, who denied marketing consent, or who replied STOP.")
            : t("Free-form WhatsApp messages are only allowed within 24 hours of the person's last message to you; outside that window the step is skipped. Use a template to start a conversation.")}</p>
        </div>
      );
    case "wait_outcome": {
      const outcome = String(s.outcome ?? "delivered");
      const sources = Array.from({ length: index }, (_, j) => j);
      const elseValue = s.else === "exit" ? "exit" : String((s.else as { goto: number }).goto);
      return (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("Wait until the message in")}</span>
            <select className="input w-auto" value={String(s.step ?? 0)} onChange={(e) => onChange({ ...s, step: Number(e.target.value) })} aria-label={t("Message step")}>
              {sources.length === 0 && <option value="0">{t("no earlier step")}</option>}
              {sources.map((j) => <option key={j} value={j}>{t("step {n}", { n: j + 1 })}</option>)}
            </select>
            <span>{t("is")}</span>
            <select className="input w-auto" value={outcome} onChange={(e) => onChange({ ...s, outcome: e.target.value })} aria-label={t("Outcome")}>
              {OUTCOMES.map((o) => <option key={o} value={o}>{t(OUTCOME_LABELS[o])}</option>)}
            </select>
            <span>{t("within")}</span>
            <input className="input w-20" type="number" min={1} max={720} value={Number(s.withinHours ?? 24)} onChange={(e) => onChange({ ...s, withinHours: Number(e.target.value) })} aria-label={t("Hours")} />
            <span>{t("h")}</span>
          </div>
          <label className="flex flex-wrap items-center gap-2">{t("Otherwise")}
            <select className="input w-auto" value={elseValue} onChange={(e) => onChange({ ...s, else: e.target.value === "exit" ? "exit" : { goto: Number(e.target.value) } })}>
              <option value="exit">{t("end the run")}</option>
              {Array.from({ length: total }, (_, j) => j).filter((j) => j > index + 1).map((j) => <option key={j} value={j}>{t("skip to step {n}", { n: j + 1 })}</option>)}
            </select>
          </label>
          <p className="help">{t("Delivered and read come from the provider's status callbacks; replied means an inbound message from the person's number. Read is reported for WhatsApp only.")}</p>
        </div>
      );
    }
    case "webhook":
      return (
        <select className="input" value={String(s.webhookId ?? "")} onChange={(e) => onChange({ ...s, webhookId: e.target.value })} aria-label={t("Webhook")}>
          <option value="">{webhooks.length ? t("Choose a webhook") : t("No webhooks in this environment (Developers → Webhooks)")}</option>
          {webhooks.map((w) => <option key={w.id} value={w.id}>{w.description ? `${w.description} — ` : ""}{w.url}</option>)}
        </select>
      );
    case "update_user_property":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("Set")}</span>
          <input className="input w-44" placeholder={t("property")} value={String(s.property ?? "")} onChange={(e) => onChange({ ...s, property: e.target.value })} aria-label={t("Property")} dir="ltr" />
          <span>{t("to")}</span>
          <ParsedInput className="input w-44" placeholder={t("value")} value={s.value} parse={(raw) => parseValue("eq", raw)} onChange={(v) => onChange({ ...s, value: v })} aria-label={t("Value")} />
        </div>
      );
    default:
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("Send")}</span>
          <input className="input w-56" list="automation-events" placeholder={t("event name")} value={String(s.event ?? "")} onChange={(e) => onChange({ ...s, event: e.target.value })} aria-label={t("Event")} dir="ltr" />
          <span className="text-ink-3">{t("for the person (shows in analytics; doesn't trigger automations)")}</span>
        </div>
      );
  }
}

/** The line between two nodes, with an insert menu. */
function Connector({ onInsert }: { onInsert?: (type: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center py-1" aria-hidden={!onInsert}>
      <span className="h-3 w-px bg-line-strong" />
      {onInsert && (
        <select className="input h-7 min-h-0 w-auto rounded-full px-2 py-0 text-xs" value="" onChange={(e) => e.target.value && onInsert(e.target.value)} aria-label={t("Insert a step here")}>
          <option value="">+</option>
          {STEP_TYPES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
        </select>
      )}
      <span className="h-3 w-px bg-line-strong" />
    </div>
  );
}
