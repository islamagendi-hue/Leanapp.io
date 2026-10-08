/**
 * The "Add widget" form: the fields each widget type asks for, turned into
 * the widget's config. Validation happens afterwards with the same report
 * schemas as everywhere else (`widgetConfig`). Pure.
 */

export const ADD_WIDGET_TYPES = ["kpi", "trend", "funnel", "retention", "revenue", "growth", "audience_size"] as const;
export type AddWidgetType = (typeof ADD_WIDGET_TYPES)[number];

export const WIDGET_TYPE_LABELS: Record<AddWidgetType, string> = {
  kpi: "Number",
  trend: "Trend",
  funnel: "Funnel",
  retention: "Retention",
  revenue: "Revenue",
  growth: "Activation number",
  audience_size: "Audience size",
};

export const FUNNEL_STEP_FIELDS = ["step1", "step2", "step3", "step4", "step5", "step6"] as const;

/** Sizes offered in the form: columns of the 12-column grid, and rows. */
export const WIDTHS = [3, 4, 6, 8, 12] as const;
export const HEIGHTS = [1, 2, 3, 4] as const;

/** The widget's config from the form's fields (empty fields left out). */
export function widgetInputFromForm(type: AddWidgetType, get: (name: string) => string | undefined): Record<string, unknown> {
  const v = (name: string) => {
    const s = get(name)?.trim();
    return s ? s : undefined;
  };
  const range = { days: v("days"), compare: v("compare"), cohortId: v("audience") };
  const out: Record<string, unknown> = (() => {
    switch (type) {
      case "kpi":
        return { metric: v("metric"), event: v("event"), ...range };
      case "trend":
        return { event: v("event"), interval: v("interval"), ...range };
      case "funnel":
        return { steps: FUNNEL_STEP_FIELDS.map(v).filter(Boolean), windowDays: v("windowDays"), ...range };
      case "retention":
        return { startEvent: v("startEvent"), returnEvent: v("returnEvent"), ...range };
      case "revenue":
        return { ...range };
      case "growth":
        return { metric: v("metric") };
      case "audience_size":
        return { audienceId: v("audience") };
    }
  })();
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined));
}
