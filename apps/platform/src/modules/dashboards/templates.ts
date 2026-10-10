/**
 * Dashboard templates: Growth, Product and Monetization. A template is a
 * list of widgets built from what the project already defines (Activation
 * steps, its events); a widget that needs something the project doesn't have
 * yet is skipped with the reason, never filled with made-up events. Pure.
 */
import { msg, type T } from "@/i18n/translate";
import { ANY_EVENT } from "@/modules/analytics/sql";
import { en } from "./localize";

export const TEMPLATES = ["growth", "product", "monetization"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export const TEMPLATE_INFO: Record<TemplateId, { name: string; description: string }> = {
  growth: { name: msg("Growth"), description: msg("DAU, WAU and MAU, activation, sign-up to activation, D7 retention and feature adoption.") },
  product: { name: msg("Product"), description: msg("Active users, feature usage, retention and the key funnel.") },
  monetization: { name: msg("Monetization"), description: msg("Revenue, paying users, conversion to paying, ARPU and revenue by audience.") },
};

/** What a template can use. Event names come from the project; null when unknown. */
export interface TemplateFacts {
  /** An install or sign-up event the app sends. */
  startEvent: string | null;
  activationEvent: string | null;
  coreEvent: string | null;
  revenueEvent: string | null;
  /** Most used events first (from the environment's data). */
  topEvents: string[];
  /** Up to a few audiences, for "revenue by audience". */
  audiences: { id: string; name: string }[];
}

export interface TemplateWidget {
  type: "trend" | "funnel" | "retention" | "revenue" | "kpi" | "growth" | "audience_size";
  title: string;
  config: Record<string, unknown>;
  w: number;
  h: number;
}

export interface TemplatePlan {
  widgets: TemplateWidget[];
  /** Widgets left out, with why (shown to the person). */
  skipped: string[];
}

const kpi = (title: string, config: Record<string, unknown>, w = 4): TemplateWidget => ({ type: "kpi", title, config: { days: 30, compare: true, ...config }, w, h: 2 });

/**
 * The widgets of a template for a project. Titles and reasons are in English
 * unless `t` translates them (they're shown, and stored as the widget titles).
 */
export function planTemplate(id: TemplateId, f: TemplateFacts, t: T = en): TemplatePlan {
  const widgets: TemplateWidget[] = [];
  const skipped: string[] = [];
  const feature = f.coreEvent ?? f.topEvents.find((e) => e !== f.startEvent && !/app_open|session|screen_view/i.test(e)) ?? null;

  if (id === "growth") {
    widgets.push({ type: "trend", title: t("DAU: active users per day"), config: { event: ANY_EVENT, days: 30, interval: "day" }, w: 12, h: 3 });
    widgets.push(kpi(t("WAU: active users, last 7 days"), { metric: "active_people", days: 7 }));
    widgets.push(kpi(t("MAU: active users, last 30 days"), { metric: "active_people", days: 30 }));
    widgets.push({ type: "growth", title: t("Activation rate"), config: { metric: "activation_rate" }, w: 4, h: 2 });
    if (f.startEvent && f.activationEvent && f.startEvent !== f.activationEvent) {
      widgets.push({ type: "funnel", title: t("Sign-up to activation"), config: { steps: [f.startEvent, f.activationEvent], windowDays: 7, days: 30 }, w: 6, h: 2 });
    } else skipped.push(t("Sign-up to activation: needs a sign-up or install event and an activation event (set it in Activation)."));
    widgets.push({ type: "growth", title: t("D7 retention"), config: { metric: "d7" }, w: 3, h: 2 });
    if (feature) widgets.push(kpi(t("Feature adoption: {event}", { event: feature }), { metric: "people", event: feature }, 3));
    else skipped.push(t("Feature adoption: needs a core action or a feature event in your data."));
  }

  if (id === "product") {
    widgets.push(kpi(t("Active users"), { metric: "active_people", days: 7 }, 6));
    widgets.push(kpi(t("New users"), { metric: "new_people", days: 7 }, 6));
    if (feature) widgets.push({ type: "trend", title: t("Feature usage: {event}", { event: feature }), config: { event: feature, days: 30 }, w: 12, h: 3 });
    else skipped.push(t("Feature usage: needs a feature event in your data."));
    widgets.push({ type: "retention", title: t("Retention (any event)"), config: { startEvent: ANY_EVENT, returnEvent: ANY_EVENT, days: 30 }, w: 6, h: 2 });
    const steps = [f.startEvent, f.activationEvent, f.coreEvent].filter((s, i, a): s is string => Boolean(s) && a.indexOf(s) === i);
    if (steps.length >= 2) widgets.push({ type: "funnel", title: t("Key funnel"), config: { steps, windowDays: 7, days: 30 }, w: 6, h: 2 });
    else skipped.push(t("Key funnel: needs at least two of a sign-up event, an activation event and a core action."));
  }

  if (id === "monetization") {
    widgets.push({ type: "revenue", title: t("Revenue and ARPU"), config: { days: 30, compare: true }, w: 12, h: 3 });
    if (f.revenueEvent) {
      widgets.push(kpi(t("Paying users"), { metric: "people", event: f.revenueEvent }, 6));
      if (f.startEvent && f.startEvent !== f.revenueEvent) {
        widgets.push({ type: "funnel", title: t("Conversion to paying"), config: { steps: [f.startEvent, f.revenueEvent], windowDays: 30, days: 30 }, w: 6, h: 2 });
      } else skipped.push(t("Conversion to paying: needs a sign-up or install event."));
    } else {
      widgets.push({ type: "growth", title: t("Paying users"), config: { metric: "paying" }, w: 6, h: 2 });
      skipped.push(t("Conversion to paying: needs a revenue event (set it in Activation)."));
    }
    if (f.audiences.length) {
      for (const a of f.audiences.slice(0, 2)) widgets.push({ type: "revenue", title: t("Revenue: {audience}", { audience: a.name }), config: { days: 30, cohortId: a.id }, w: 6, h: 2 });
    } else skipped.push(t("Revenue by audience: create an audience first, then add a Revenue widget filtered by it."));
  }
  return { widgets, skipped };
}
