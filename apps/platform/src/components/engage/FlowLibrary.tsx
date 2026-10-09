import { applyFlowTemplateAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { AR } from "@/i18n/ar";
import { getT } from "@/i18n/server";
import { LANG_NAMES, makeT, msg, type Lang, type T } from "@/i18n/translate";
import { describeStep, describeTrigger, parseAutomation, type Step } from "@/modules/automation/definition";
import {
  CHANNEL_LABELS, EVENT_SLOTS, FLOW_CATEGORIES, FLOW_GOALS, FLOW_TEMPLATES, PENDING_AUDIENCE_ID, PENDING_WHATSAPP,
  filterFlowTemplates, flowReadiness, planFlowTemplate, suggestedEvents,
  type ChannelState, type EventStatus, type FlowTemplate, type KnownEvents, type ReadinessIssue,
} from "@/modules/automation/library";
import type { WhatsAppTemplate } from "@/modules/whatsapp/service";

const STATUS: Record<EventStatus, { text: string; tone: string } | null> = {
  received: { text: msg("sent by your app"), tone: "border-accent/40 text-accent-ink" },
  planned: { text: msg("planned, not received"), tone: "border-warn/40 bg-warn-soft text-warn" },
  missing: { text: msg("not tracked yet"), tone: "border-warn/40 bg-warn-soft text-warn" },
  unknown: null,
};

const STEP_KIND: Partial<Record<Step["type"], string>> = { push: msg("Push"), email: msg("Email"), in_app: msg("In-app"), whatsapp: "WhatsApp" };

/**
 * The flows library on the Flows page. Search and filters are a plain GET
 * form, and "Use this flow" a form posting to a server action, so all of it
 * works before (or without) client JavaScript. Each card shows what the flow
 * does, a preview of its steps with the messages in the chosen language,
 * the events it needs (matched to this app's events or tracking plan), what's
 * missing in this environment with a link to fix it, and the button that
 * creates the draft.
 */
export async function FlowLibrary({ org, app, environmentId, envType, envLabel, known, eventNames, channels, whatsappTemplates, canCreate, canManageAudiences, filters, copyLang }: {
  org: string;
  app: string;
  environmentId: string;
  envType: string;
  envLabel: string;
  known: KnownEvents;
  /** Event names to suggest in the inputs (received or planned). */
  eventNames: string[];
  channels: ChannelState;
  /** Approved templates without a header variable. */
  whatsappTemplates: WhatsAppTemplate[];
  canCreate: boolean;
  canManageAudiences: boolean;
  filters: { q: string; category: string; goal: string };
  copyLang: Lang;
}) {
  const t = await getT();
  const copyT = makeT(copyLang === "ar" ? AR : null);
  const base = `/o/${org}/apps/${app}`;
  const category = filters.category in FLOW_CATEGORIES ? filters.category : "";
  const goal = filters.goal in FLOW_GOALS ? filters.goal : "";
  const shown = filterFlowTemplates({ q: filters.q, category, goal }, t);
  const filtered = !!(filters.q.trim() || category || goal);
  const links = {
    plan: `${base}/settings/dev-ops/implementation/plan`,
    debugger: `${base}/settings/dev-ops/debugger?env=${envType}`,
    channels: `${base}/settings/dev-ops/channels?env=${envType}`,
  };

  return (
    <section id="library" className="space-y-4" aria-label={t("Flows library")}>
      <div>
        <h2 className="h2">{t("Start from a template")}</h2>
        <p className="max-w-2xl text-sm text-ink-3">
          {t("Ready-made flows, created as drafts with events, messages and timing filled in.")}
        </p>
      </div>

      <form method="get" action={`${base}/engage/automations#library`} className="card grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]" role="search" aria-label={t("Search the library")}>
        <input type="hidden" name="env" value={envType} />
        <label className="col-span-2 block lg:col-span-1">
          <span className="label">{t("Search")}</span>
          <input type="search" name="q" defaultValue={filters.q} className="input" placeholder={t("Cart, trial, WhatsApp…")} maxLength={100} />
        </label>
        <label className="block">
          <span className="label">{t("Category")}</span>
          <select name="category" defaultValue={category} className="input">
            <option value="">{t("All categories")}</option>
            {Object.entries(FLOW_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">{t("Goal")}</span>
          <select name="goal" defaultValue={goal} className="input">
            <option value="">{t("All goals")}</option>
            {Object.entries(FLOW_GOALS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">{t("Message language")}</span>
          <select name="copy" defaultValue={copyLang} className="input">
            {(Object.keys(LANG_NAMES) as Lang[]).map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-secondary">{t("Apply")}</button>
          {filtered && <a className="text-sm text-ink-2 hover:underline" href={`${base}/engage/automations?env=${envType}&copy=${copyLang}#library`}>{t("Clear")}</a>}
        </div>
      </form>

      <p className="text-sm text-ink-3" aria-live="polite">{t("Showing {n} of {total} flows", { n: shown.length, total: FLOW_TEMPLATES.length })}</p>
      {eventNames.length > 0 && <datalist id="flow-library-events">{eventNames.map((e) => <option key={e} value={e} />)}</datalist>}

      {shown.length === 0 ? (
        <p className="card text-sm text-ink-3">{t("No flow matches. Try another word or clear the filters.")}</p>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((tpl) => (
            <TemplateCard key={tpl.id} tpl={tpl} t={t} copyT={copyT} copyLang={copyLang} known={known} channels={channels} links={links} envLabel={envLabel}
              whatsappTemplates={whatsappTemplates} canCreate={canCreate} canManageAudiences={canManageAudiences} hasSuggestions={eventNames.length > 0}
              action={applyFlowTemplateAction.bind(null, org, app, environmentId, tpl.id)} />
          ))}
        </div>
      )}
      {canCreate && (
        <ul className="space-y-1 text-xs text-ink-3">
          <li>{t("Nothing is sent until you activate a flow.")}</li>
          <li>{t("Flows keep the frequency cap and quiet hours.")}</li>
          <li>{t("In-app messages show once your app fetches them.")}</li>
          <li>{t("You can edit every step after creating a flow.")}</li>
        </ul>
      )}
    </section>
  );
}

function TemplateCard({ tpl, t, copyT, copyLang, known, channels, links, envLabel, whatsappTemplates, canCreate, canManageAudiences, hasSuggestions, action }: {
  tpl: FlowTemplate;
  t: T;
  copyT: T;
  copyLang: Lang;
  known: KnownEvents;
  channels: ChannelState;
  links: { plan: string; debugger: string; channels: string };
  envLabel: string;
  whatsappTemplates: WhatsAppTemplate[];
  canCreate: boolean;
  canManageAudiences: boolean;
  hasSuggestions: boolean;
  action: Parameters<typeof ActionForm>[0]["action"];
}) {
  const events = suggestedEvents(tpl, known);
  const plan = planFlowTemplate(tpl.id as Parameters<typeof planFlowTemplate>[0], {}, copyT, known);
  const definition = parseAutomation(plan.definition);
  const { issues, blocking } = flowReadiness(tpl, {
    events, channels, approvedWhatsAppTemplates: whatsappTemplates.length, canManageAudiences, audienceName: plan.audience?.name,
  });
  const audienceName = (id: string) => (id === PENDING_AUDIENCE_ID && plan.audience ? plan.audience.name : t("an audience"));
  const copyAttrs = { lang: copyLang, dir: copyLang === "ar" ? "rtl" : "ltr" } as const;
  const headingId = `flow-${tpl.id}`;

  const eventRows = events.map(({ slot, event, status }) => {
    const pill = STATUS[status];
    return (
      <li key={slot} className="space-y-1">
        <span className="block text-xs text-ink-3">{t(EVENT_SLOTS[slot].label)}</span>
        <span className="flex flex-wrap items-center gap-2">
          {canCreate && !blocking ? (
            <input name={`event.${slot}`} defaultValue={event} className="input max-w-56 font-mono text-xs" dir="ltr" maxLength={200} required
              list={hasSuggestions ? "flow-library-events" : undefined} aria-label={t(EVENT_SLOTS[slot].label)} />
          ) : (
            <code className="text-xs" dir="ltr">{event}</code>
          )}
          {pill && <span className={`pill ${pill.tone}`}>{t(pill.text)}</span>}
        </span>
      </li>
    );
  });

  return (
    <article className="card flex flex-col gap-4" data-flow-template={tpl.id} aria-labelledby={headingId}>
      <header className="space-y-1">
        <p className="flex flex-wrap gap-x-2 text-xs text-ink-3">
          <span>{t(FLOW_CATEGORIES[tpl.category])}</span><span aria-hidden="true">·</span><span>{t("Goal: {goal}", { goal: t(FLOW_GOALS[tpl.goal]) })}</span>
        </p>
        <h3 id={headingId} className="font-medium">{t(tpl.name)}</h3>
        <p className="text-sm text-ink-2">{t(tpl.description)}</p>
      </header>

      <ul className="flex flex-wrap gap-2" aria-label={t("Channels")}>
        {tpl.channels.map((c) => (
          <li key={c} className={`pill ${channels[c] === false ? "border-warn/40 bg-warn-soft text-warn" : "border-line text-ink-2"}`}>
            {channels[c] === false ? t("{channel}: not connected", { channel: t(CHANNEL_LABELS[c]) }) : t(CHANNEL_LABELS[c])}
          </li>
        ))}
      </ul>

      <details className="rounded-lg border border-line p-3 text-sm">
        <summary className="cursor-pointer font-medium text-ink-2">{t("Preview the steps")}</summary>
        <p className="mt-3 text-xs text-ink-2">{describeTrigger(definition.trigger, audienceName, t)}</p>
        <ol className="mt-2 space-y-2 border-s border-line ps-3">
          {definition.steps.map((s, i) => <PreviewStep key={i} step={s} n={i + 1} t={t} copyAttrs={copyAttrs} />)}
        </ol>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-ink-3">
          {definition.goal && <><dt>{t("Goal event")}</dt><dd><code dir="ltr">{definition.goal.event}</code> · {t("{n} days", { n: definition.goal.withinDays })}</dd></>}
          {definition.exitEvent && <><dt>{t("Exit event")}</dt><dd><code dir="ltr">{definition.exitEvent}</code></dd></>}
        </dl>
      </details>

      <div className="space-y-2">
        {issues.length === 0 ? (
          <p className="text-sm text-accent-ink">{t("Ready: its events arrive and its channels are connected.")}</p>
        ) : (
          <>
            <p className="text-xs font-medium text-ink-2">{t("Before it can run")}</p>
            <ul className="space-y-1.5 text-xs text-ink-2">{issues.map((issue, i) => <Issue key={i} issue={issue} t={t} links={links} envLabel={envLabel} />)}</ul>
          </>
        )}
      </div>

      {canCreate && !blocking ? (
        <ActionForm action={action} submitLabel={t("Use this flow")} buttonClass="btn" className="space-y-3">
          <input type="hidden" name="lang" value={copyLang} />
          <p className="text-xs font-medium text-ink-2">{t("Events it needs")}</p>
          <ul className="space-y-2">{eventRows}</ul>
          {tpl.channels.includes("whatsapp") && (
            <div className="space-y-2">
              <label className="block">
                <span className="label">{t("WhatsApp template")}</span>
                <select name="whatsapp" className="input" required defaultValue="">
                  <option value="" disabled>{t("Choose a template")}</option>
                  {whatsappTemplates.map((w) => (
                    <option key={`${w.name}|${w.language}`} value={`${w.name}|${w.language}`}>
                      {t("{name} ({language}), {n} variables", { name: w.name, language: w.language, n: w.body_params })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">{t("Template variables, one per line")}</span>
                <textarea name="whatsapp.params" className="input min-h-16 py-2 font-mono text-xs" dir="ltr" rows={2} placeholder={"{{user.first_name}}"} />
                <span className="help block">{t("Leave empty when the template has no variables.")}</span>
              </label>
            </div>
          )}
          <p className="text-xs text-ink-3">{t("Saved as a draft, in {language}.", { language: LANG_NAMES[copyLang] })}</p>
        </ActionForm>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-2">{t("Events it needs")}</p>
          <ul className="space-y-2">{eventRows}</ul>
          {canCreate && blocking && <p className="text-xs text-warn">{t("Fix the items above to use this flow.")}</p>}
        </div>
      )}
    </article>
  );
}

function PreviewStep({ step: s, n, t, copyAttrs }: { step: Step; n: number; t: T; copyAttrs: { lang: Lang; dir: "rtl" | "ltr" } }) {
  const kind = STEP_KIND[s.type];
  if (!kind) return <li className="text-xs text-ink-3">{n}. {describeStep(s, t)}</li>;
  const title = s.type === "email" ? s.subject : s.type === "push" || s.type === "in_app" ? s.title : null;
  const body = s.type === "email" || s.type === "push" || s.type === "in_app" ? s.body : null;
  return (
    <li className="space-y-0.5">
      <span className="block text-xs text-ink-3">{n}. {t(kind)}</span>
      {s.type === "whatsapp" ? (
        <span className="block text-xs text-ink-2">{s.template === PENDING_WHATSAPP ? t("The approved WhatsApp template you choose below.") : describeStep(s, t)}</span>
      ) : (
        <span className="block" {...copyAttrs}>
          <span className="block font-medium">{title}</span>
          <span className="block text-xs text-ink-2">{body}</span>
        </span>
      )}
    </li>
  );
}

function Issue({ issue, t, links, envLabel }: { issue: ReadinessIssue; t: T; links: { plan: string; debugger: string; channels: string }; envLabel: string }) {
  const item = (text: React.ReactNode, href?: string, label?: string) => (
    <li className="space-y-0.5">
      <p>{text}</p>
      {href && <a className="block w-fit font-medium text-ink underline underline-offset-2" href={href}>{label}</a>}
    </li>
  );
  const code = (event: string) => <code dir="ltr">{event}</code>;
  switch (issue.kind) {
    case "event":
      return issue.status === "missing"
        ? item(<>{code(issue.event)} {t("isn't tracked yet.")}</>, links.plan, t("Add it to the tracking plan"))
        : item(<>{code(issue.event)} {t("hasn't arrived in {env} yet.", { env: envLabel })}</>, links.debugger, t("Check the event debugger"));
    case "channel":
      return item(t("{channel} isn't connected in {env}.", { channel: t(CHANNEL_LABELS[issue.channel]), env: envLabel }), links.channels, t("Connect {channel}", { channel: t(CHANNEL_LABELS[issue.channel]) }));
    case "whatsapp_template":
      return item(t("No approved WhatsApp template is synced yet."), links.channels, t("Sync WhatsApp templates"));
    case "audience":
      return item(<>{t("Also creates this audience as a draft:")} <strong className="block font-medium">{issue.name}</strong>{t("Activate it before the flow.")}</>);
    case "audience_permission":
      return item(t("This flow creates an audience, which your role can't do."));
  }
}
