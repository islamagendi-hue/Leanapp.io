"use client";

import { useState } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { flowNodes, insertStep, moveStep, removeStep } from "@/modules/automation/flow";
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
  ["delay", "Wait"],
  ["condition", "Condition: continue only if"],
  ["branch", "Branch: if / otherwise"],
  ["push", "Push notification"],
  ["in_app", "In-app message"],
  ["email", "Email"],
  ["whatsapp", "WhatsApp template"],
  ["webhook", "Webhook"],
  ["update_user_property", "Update user property"],
  ["send_event", "Send event"],
  ["exit", "Exit"],
];
const KIND: Record<string, { label: string; tone: string }> = {
  delay: { label: "Wait", tone: "border-s-ink-3" },
  condition: { label: "Condition", tone: "border-s-warn" },
  branch: { label: "Branch", tone: "border-s-warn" },
  push: { label: "Message", tone: "border-s-accent" },
  in_app: { label: "Message", tone: "border-s-accent" },
  email: { label: "Message", tone: "border-s-accent" },
  whatsapp: { label: "Message", tone: "border-s-accent" },
  webhook: { label: "Action", tone: "border-s-line-strong" },
  update_user_property: { label: "Action", tone: "border-s-line-strong" },
  send_event: { label: "Action", tone: "border-s-line-strong" },
  exit: { label: "Exit", tone: "border-s-alert" },
};
const kindOf = (s: Step) => (s.type === "branch" ? (s.else === "exit" ? "condition" : "branch") : s.type);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
    case "whatsapp": return { type, template: "", language: "", bodyParams: [], headerParams: [], phoneProperty: "phone" };
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

export interface WhatsAppTemplateOption { name: string; language: string; status: string; body_params: number; header_params: number; body_text: string | null }
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
  const t = d.trigger;
  const audienceSelect = (
    <select className="input w-auto" value={String(t.audienceId ?? "")} onChange={(e) => set({ trigger: { ...t, audienceId: e.target.value } })} aria-label="Audience">
      <option value="">Choose an audience</option>
      {audiences.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== "active" ? ` (${a.status})` : ""}</option>)}
    </select>
  );

  return (
    <ActionForm action={save} submitLabel="Save" className="space-y-6">
      <input type="hidden" name="definition" value={JSON.stringify(d)} />
      <datalist id="automation-events">{events.map((e) => <option key={e} value={e} />)}</datalist>
      <label className="block max-w-md"><span className="label">Name</span><input name="name" className="input" defaultValue={name} required maxLength={80} /></label>

      <fieldset className="space-y-2 rounded-lg border border-line border-s-4 border-s-ink bg-card p-4" data-step="trigger">
        <legend className="px-1 text-sm font-bold">Trigger</legend>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" value={t.type} onChange={(e) => {
            const type = e.target.value;
            set({ trigger: type === "event" ? { type, event: "" } : type === "schedule" ? { type, audienceId: t.audienceId ?? "", every: "day", at: "10:00" } : { type, audienceId: t.audienceId ?? "" } });
          }}>
            <option value="event">When someone does an event</option>
            <option value="audience_entered">When someone enters an audience</option>
            <option value="audience_exited">When someone leaves an audience</option>
            <option value="schedule">On a schedule, for an audience</option>
          </select>
          {t.type === "event" && <input className="input w-60" list="automation-events" placeholder="event name" value={String(t.event ?? "")} onChange={(e) => set({ trigger: { ...t, event: e.target.value } })} aria-label="Event" />}
          {t.type !== "event" && audienceSelect}
          {t.type === "schedule" && (
            <>
              <select className="input w-auto" value={String(t.every)} onChange={(e) => set({ trigger: { ...t, every: e.target.value, weekday: e.target.value === "week" ? (t.weekday ?? 0) : undefined } })}>
                <option value="day">every day</option>
                <option value="week">every week on</option>
              </select>
              {t.every === "week" && (
                <select className="input w-auto" value={String(t.weekday ?? 0)} onChange={(e) => set({ trigger: { ...t, weekday: Number(e.target.value) } })}>
                  {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
                </select>
              )}
              <span>at</span>
              <input className="input w-28" type="time" value={String(t.at ?? "10:00")} onChange={(e) => set({ trigger: { ...t, at: e.target.value } })} aria-label="Time" />
              <span className="text-ink-3">({timezone})</span>
            </>
          )}
        </div>
        <p className="help">Only events and audience changes after activation start runs. Events sent by automations never trigger automations.</p>
      </fieldset>

      <fieldset className="space-y-0" aria-label="Flow">
        <legend className="sr-only">Steps</legend>
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
                    <span className="pill border-line text-xs">{KIND[k]?.label ?? k}</span>
                    <select className="input w-auto" value={k} onChange={(e) => setStep(i, defaultStep(e.target.value, i, d.steps.length))} aria-label={`Step ${i + 1} type`}>
                      {STEP_TYPES.map(([key, l]) => <option key={key} value={key}>{l}</option>)}
                    </select>
                    <span className="ms-auto flex gap-2 text-xs">
                      {i > 0 && <button type="button" className="hover:underline" onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</button>}
                      {i < d.steps.length - 1 && <button type="button" className="hover:underline" onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</button>}
                      {d.steps.length > 1 && <button type="button" className="text-alert hover:underline" onClick={() => set({ steps: removeStep(d.steps, i) })}>Remove</button>}
                    </span>
                  </div>
                  <StepFields step={s} index={i} total={d.steps.length} onChange={(x) => setStep(i, x)} events={events} properties={properties} webhooks={webhooks} whatsappTemplates={whatsappTemplates} emailTemplates={emailTemplates} />
                  {s.type === "branch" && (
                    <p className="flex flex-wrap gap-2 text-xs">
                      <span className="pill border-accent/40 text-accent-ink">Yes → step {i + 2 <= d.steps.length ? i + 2 : "end"}</span>
                      <span className={`pill ${n.broken ? "border-alert/40 text-alert" : "border-warn/40 text-warn"}`}>No → {n.no === "exit" ? "exit" : `step ${n.no}`}{n.broken ? " (must be a later step)" : ""}</span>
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <Connector onInsert={d.steps.length < 50 ? (type) => insert(d.steps.length, type) : undefined} />
        <div className="rounded-lg border border-dashed border-line px-3 py-2 text-center text-sm text-ink-3">End of flow</div>
        <p className="help mt-2">Text can use {"{{user.<property>}}"} and {"{{event.<property>}}"} (the trigger event). A branch&apos;s &ldquo;yes&rdquo; path runs into the next steps; end it with Exit when the &ldquo;no&rdquo; path follows.</p>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-line p-4 md:grid-cols-2">
        <legend className="px-1 text-sm font-bold">Goal and exit</legend>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={Boolean(d.goal)} onChange={(e) => set({ goal: e.target.checked ? { event: "", withinDays: 7, stopOnConversion: true } : null })} /> Conversion goal</label>
          {d.goal && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                The person does
                <input className="input w-52" list="automation-events" placeholder="event name" value={d.goal.event} onChange={(e) => set({ goal: { ...d.goal!, event: e.target.value } })} aria-label="Goal event" />
                within
                <input className="input w-20" type="number" min={1} max={90} value={d.goal.withinDays} onChange={(e) => set({ goal: { ...d.goal!, withinDays: Number(e.target.value) } })} aria-label="Goal window (days)" /> days
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={d.goal.stopOnConversion} onChange={(e) => set({ goal: { ...d.goal!, stopOnConversion: e.target.checked } })} /> Stop the flow for people who converted</label>
            </div>
          )}
          <p className="help">Counted from the trigger. The flow&apos;s page reports how many people converted.</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.exitEvent !== null && d.exitEvent !== undefined} onChange={(e) => set({ exitEvent: e.target.checked ? "" : null })} /> Exit event</label>
          {d.exitEvent !== null && d.exitEvent !== undefined && (
            <input className="input w-60" list="automation-events" placeholder="event name" value={d.exitEvent} onChange={(e) => set({ exitEvent: e.target.value })} aria-label="Exit event" />
          )}
          <p className="help">When the person does this event after the trigger, their run ends before the next step, e.g. an order placed during a cart reminder flow.</p>
        </div>
      </fieldset>

      <fieldset className="grid gap-4 rounded-lg border border-line p-4 md:grid-cols-3">
        <legend className="px-1 text-sm font-bold">Guardrails</legend>
        <div className="space-y-2 text-sm">
          <p className="label">Entry</p>
          <select className="input" value={d.entry.mode} onChange={(e) => set({ entry: { ...d.entry, mode: e.target.value } })}>
            <option value="every_time">Each time triggered</option>
            <option value="once">Once per person, ever</option>
          </select>
          {d.entry.mode === "every_time" && (
            <label className="flex items-center gap-2">at most every <input className="input w-20" type="number" min={0} value={d.entry.cooldownHours} onChange={(e) => set({ entry: { ...d.entry, cooldownHours: Number(e.target.value) } })} /> h</label>
          )}
          <p className="help">Never while the person already has a run in progress.</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.frequencyCap !== null} onChange={(e) => set({ frequencyCap: e.target.checked ? { messages: 3, hours: 24 } : null })} /> Frequency cap</label>
          {d.frequencyCap && (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-16" type="number" min={1} max={100} value={d.frequencyCap.messages} onChange={(e) => set({ frequencyCap: { ...d.frequencyCap!, messages: Number(e.target.value) } })} />
              messages per
              <input className="input w-20" type="number" min={1} max={720} value={d.frequencyCap.hours} onChange={(e) => set({ frequencyCap: { ...d.frequencyCap!, hours: Number(e.target.value) } })} /> h
            </div>
          )}
          <p className="help">Counts push, email, WhatsApp and in-app messages to the person from all automations here; over the cap, the message is skipped.</p>
        </div>
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={d.quietHours !== null} onChange={(e) => set({ quietHours: e.target.checked ? { start: "22:00", end: "08:00" } : null })} /> Quiet hours</label>
          {d.quietHours && (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-28" type="time" value={d.quietHours.start} onChange={(e) => set({ quietHours: { ...d.quietHours!, start: e.target.value } })} />–
              <input className="input w-28" type="time" value={d.quietHours.end} onChange={(e) => set({ quietHours: { ...d.quietHours!, end: e.target.value } })} />
            </div>
          )}
          <p className="help">Push, email and WhatsApp wait until quiet hours end ({timezone}, the organization&apos;s timezone).</p>
        </div>
      </fieldset>
    </ActionForm>
  );
}

function StepFields({ step: s, index, total, onChange, events, properties, webhooks, whatsappTemplates, emailTemplates }: Channels & {
  step: Step; index: number; total: number; onChange: (s: Step) => void; events: string[]; properties?: PropertyLists;
  webhooks: { id: string; url: string; description: string | null }[];
}) {
  const text = (k: string, label: string, max: number, area = false) => (
    <label className="block text-sm"><span className="label">{label}</span>
      {area
        ? <textarea className="input min-h-24 py-2" maxLength={max} value={String(s[k] ?? "")} onChange={(e) => onChange({ ...s, [k]: e.target.value })} />
        : <input className="input" maxLength={max} value={String(s[k] ?? "")} onChange={(e) => onChange({ ...s, [k]: e.target.value || (k === "deepLink" || k === "buttonText" ? undefined : "") })} />}
    </label>
  );
  switch (s.type) {
    case "exit":
      return <p className="text-sm text-ink-2">The run ends here.</p>;
    case "delay":
      return (
        <div className="flex items-center gap-2 text-sm">
          <input className="input w-24" type="number" min={1} value={Number(s.amount)} onChange={(e) => onChange({ ...s, amount: Number(e.target.value) })} aria-label="Amount" />
          <select className="input w-auto" value={String(s.unit)} onChange={(e) => onChange({ ...s, unit: e.target.value })} aria-label="Unit">
            <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
          </select>
        </div>
      );
    case "branch": {
      const elseValue = s.else === "exit" ? "exit" : String((s.else as { goto: number }).goto);
      return (
        <div className="space-y-2 text-sm">
          <p>Continue if the person matches:</p>
          <ConditionBuilder value={s.condition as Step} onChange={(c) => onChange({ ...s, condition: c })} events={events} properties={properties} allowSinceTrigger />
          <label className="flex flex-wrap items-center gap-2">Otherwise
            <select className="input w-auto" value={elseValue} onChange={(e) => onChange({ ...s, else: e.target.value === "exit" ? "exit" : { goto: Number(e.target.value) } })}>
              <option value="exit">end the run</option>
              {Array.from({ length: total }, (_, j) => j).filter((j) => j > index + 1).map((j) => <option key={j} value={j}>skip to step {j + 1}</option>)}
            </select>
          </label>
        </div>
      );
    }
    case "push":
      return <div className="grid gap-2 md:grid-cols-2">{text("title", "Title", 120)}{text("deepLink", "Deep link (optional)", 500)}<div className="md:col-span-2">{text("body", "Message", 500, true)}</div></div>;
    case "in_app":
      return (
        <div className="grid gap-2 md:grid-cols-2">
          {text("title", "Title", 120)}{text("buttonText", "Button (optional)", 40)}
          <div className="md:col-span-2">{text("body", "Message", 1000, true)}</div>
          {text("deepLink", "Button link (optional)", 500)}
          <label className="block text-sm"><span className="label">Expires after (hours)</span><input className="input" type="number" min={1} max={720} value={Number(s.expiresInHours ?? 72)} onChange={(e) => onChange({ ...s, expiresInHours: Number(e.target.value) })} /></label>
        </div>
      );
    case "email": {
      const templateId = String(s.templateId ?? "");
      return (
        <div className="space-y-2">
          <label className="block text-sm"><span className="label">Content</span>
            <select className="input" value={templateId} onChange={(e) => onChange(e.target.value ? { type: "email", templateId: e.target.value } : { type: "email", subject: "", body: "" })}>
              <option value="">Write it here</option>
              {emailTemplates.map((t) => <option key={t.id} value={t.id}>Template: {t.name}</option>)}
            </select>
          </label>
          {!templateId && <>{text("subject", "Subject", 200)}{text("body", "Text", 20_000, true)}</>}
          <p className="help">Sent to the person&apos;s <code>email</code> user property through your Resend account, with an unsubscribe link. Skipped for people who unsubscribed or denied marketing consent.</p>
        </div>
      );
    }
    case "whatsapp": {
      const key = s.template ? `${String(s.template)}|${String(s.language)}` : "";
      const tpl = whatsappTemplates.find((t) => `${t.name}|${t.language}` === key);
      const params = (k: "bodyParams" | "headerParams") => (Array.isArray(s[k]) ? (s[k] as string[]) : []);
      const setParam = (k: "bodyParams" | "headerParams", j: number, v: string) => {
        const next = [...params(k)];
        next[j] = v;
        onChange({ ...s, [k]: next });
      };
      return (
        <div className="space-y-2 text-sm">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="block"><span className="label">Approved template</span>
              <select className="input" value={key} onChange={(e) => {
                const t = whatsappTemplates.find((x) => `${x.name}|${x.language}` === e.target.value);
                onChange({ ...s, template: t?.name ?? "", language: t?.language ?? "", bodyParams: Array(t?.body_params ?? 0).fill(""), headerParams: Array(t?.header_params ?? 0).fill("") });
              }}>
                <option value="">{whatsappTemplates.length ? "Choose a template" : "No templates synced (Engage → Integrations)"}</option>
                {whatsappTemplates.map((t) => <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`} disabled={t.status !== "APPROVED"}>{t.name} ({t.language}){t.status !== "APPROVED" ? ` · ${t.status.toLowerCase()}` : ""}</option>)}
              </select>
            </label>
            <label className="block"><span className="label">Phone number user property (E.164)</span>
              <input className="input font-mono" value={String(s.phoneProperty ?? "phone")} onChange={(e) => onChange({ ...s, phoneProperty: e.target.value })} />
            </label>
          </div>
          {tpl?.body_text && <p className="whitespace-pre-wrap rounded-lg bg-paper-2 p-2 text-ink-2">{tpl.body_text}</p>}
          {params("headerParams").map((v, j) => (
            <label key={`h${j}`} className="block"><span className="label">Header {`{{${j + 1}}}`}</span><input className="input" maxLength={60} value={v} onChange={(e) => setParam("headerParams", j, e.target.value)} /></label>
          ))}
          {params("bodyParams").map((v, j) => (
            <label key={`b${j}`} className="block"><span className="label">Body {`{{${j + 1}}}`}</span><input className="input" maxLength={1024} placeholder="{{user.name}}" value={v} onChange={(e) => setParam("bodyParams", j, e.target.value)} /></label>
          ))}
          <p className="help">Only templates approved by WhatsApp can be sent. Skipped for people without a valid number, who denied marketing consent, or who replied STOP.</p>
        </div>
      );
    }
    case "webhook":
      return (
        <select className="input" value={String(s.webhookId ?? "")} onChange={(e) => onChange({ ...s, webhookId: e.target.value })} aria-label="Webhook">
          <option value="">{webhooks.length ? "Choose a webhook" : "No webhooks in this environment (Developers → Webhooks)"}</option>
          {webhooks.map((w) => <option key={w.id} value={w.id}>{w.description ? `${w.description} — ` : ""}{w.url}</option>)}
        </select>
      );
    case "update_user_property":
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Set</span>
          <input className="input w-44" placeholder="property" value={String(s.property ?? "")} onChange={(e) => onChange({ ...s, property: e.target.value })} aria-label="Property" />
          <span>to</span>
          <ParsedInput className="input w-44" placeholder="value" value={s.value} parse={(raw) => parseValue("eq", raw)} onChange={(v) => onChange({ ...s, value: v })} aria-label="Value" />
        </div>
      );
    default:
      return (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Send</span>
          <input className="input w-56" list="automation-events" placeholder="event name" value={String(s.event ?? "")} onChange={(e) => onChange({ ...s, event: e.target.value })} aria-label="Event" />
          <span className="text-ink-3">for the person (shows in analytics; doesn&apos;t trigger automations)</span>
        </div>
      );
  }
}

/** The line between two nodes, with an insert menu. */
function Connector({ onInsert }: { onInsert?: (type: string) => void }) {
  return (
    <div className="flex flex-col items-center py-1" aria-hidden={!onInsert}>
      <span className="h-3 w-px bg-line-strong" />
      {onInsert && (
        <select className="input h-7 min-h-0 w-auto rounded-full px-2 py-0 text-xs" value="" onChange={(e) => e.target.value && onInsert(e.target.value)} aria-label="Insert a step here">
          <option value="">+</option>
          {STEP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      )}
      <span className="h-3 w-px bg-line-strong" />
    </div>
  );
}
