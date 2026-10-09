import { applyFlowTemplateAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { describeStep, describeTrigger, parseAutomation } from "@/modules/automation/definition";
import { EVENT_SLOTS, FLOW_CATEGORIES, FLOW_TEMPLATES, planFlowTemplate, suggestedEvents } from "@/modules/automation/library";

const CHANNEL_TEXT: Record<string, string> = { push: msg("Push"), email: msg("Email"), in_app: msg("In-app") };

/**
 * The flows library on the Flows page: one card per template with what it
 * does, the events it needs (marking those this environment hasn't seen) and,
 * for people who can create flows, "Use this flow", which creates a draft.
 * `knownEvents` is null when the reader can't see the app's events.
 */
export async function FlowLibrary({ org, app, environmentId, envLabel, knownEvents, canCreate }: {
  org: string;
  app: string;
  environmentId: string;
  envLabel: string;
  knownEvents: string[] | null;
  canCreate: boolean;
}) {
  const t = await getT();
  const seen = knownEvents ? new Set(knownEvents) : null;
  return (
    <section id="library" className="space-y-3" aria-label={t("Flows library")}>
      <div>
        <h2 className="h2">{t("Start from a template")}</h2>
        <p className="max-w-2xl text-sm text-ink-3">
          {t("Ready-made flows for common moments. Each is created as a draft with its events, messages and timing filled in; nothing is sent until you review it and activate it.")}
        </p>
      </div>
      {knownEvents && knownEvents.length > 0 && <datalist id="flow-library-events">{knownEvents.map((e) => <option key={e} value={e} />)}</datalist>}
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {FLOW_TEMPLATES.map((tpl) => {
          const events = suggestedEvents(tpl, seen);
          const definition = parseAutomation(planFlowTemplate(tpl.id, {}, t, seen).definition);
          const missing = events.filter((e) => e.seen === false).length;
          const eventRows = events.map(({ slot, event, seen: isSeen }) => (
            <li key={slot} className="space-y-1">
              <span className="block text-xs text-ink-3">{t(EVENT_SLOTS[slot].label)}</span>
              <span className="flex flex-wrap items-center gap-2">
                {canCreate ? (
                  <input name={`event.${slot}`} defaultValue={event} className="input max-w-56 font-mono text-xs" dir="ltr" maxLength={200} required
                    list={knownEvents?.length ? "flow-library-events" : undefined} aria-label={t(EVENT_SLOTS[slot].label)} />
                ) : (
                  <code className="text-xs" dir="ltr">{event}</code>
                )}
                {isSeen === false && <span className="pill border-warn/40 bg-warn-soft text-xs text-warn">{t("not seen in {env} yet", { env: envLabel })}</span>}
                {isSeen === true && <span className="pill border-accent/40 text-xs text-accent-ink">{t("seen")}</span>}
              </span>
            </li>
          ));
          return (
            <div key={tpl.id} className="card flex flex-col gap-3" data-flow-template={tpl.id}>
              <div className="space-y-1">
                <p className="text-xs text-ink-3">{t(FLOW_CATEGORIES[tpl.category])} · {tpl.channels.map((c) => t(CHANNEL_TEXT[c])).join(" · ")}</p>
                <h3 className="font-medium">{t(tpl.name)}</h3>
                <p className="text-sm text-ink-2">{t(tpl.description)}</p>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-ink-2">{t("Steps")}</summary>
                <p className="mt-2 text-xs text-ink-2">{describeTrigger(definition.trigger, undefined, t)}</p>
                <ol className="mt-1 list-decimal space-y-0.5 ps-5 text-xs text-ink-2">
                  {definition.steps.map((s, i) => <li key={i}>{describeStep(s, t)}</li>)}
                </ol>
                {definition.goal && <p className="mt-1 text-xs text-ink-3">{t("Goal: {event} within {n} days", { event: definition.goal.event, n: definition.goal.withinDays })}</p>}
                {definition.exitEvent && <p className="text-xs text-ink-3">{t("Exit event: {event}", { event: definition.exitEvent })}</p>}
              </details>
              {canCreate ? (
                <ActionForm action={applyFlowTemplateAction.bind(null, org, app, environmentId, tpl.id)} submitLabel={t("Use this flow")} buttonClass="btn-secondary" className="space-y-3">
                  <p className="text-xs font-medium text-ink-2">{t("Events it needs")}</p>
                  <ul className="space-y-2">{eventRows}</ul>
                  {missing > 0 && <p className="text-xs text-ink-3">{t("Events not seen yet won't start the flow until your app sends them. Change them to events you already track, or keep them and add tracking later.")}</p>}
                </ActionForm>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-ink-2">{t("Events it needs")}</p>
                  <ul className="space-y-2">{eventRows}</ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {canCreate && <p className="text-xs text-ink-3">{t("Push needs FCM or APNs and email needs Resend, connected in Integrations. You can edit every step after creating the flow.")}</p>}
    </section>
  );
}
