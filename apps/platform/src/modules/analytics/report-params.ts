/**
 * Report settings ⇄ URL search params. Pages read their settings from the URL,
 * saved reports store the validated settings, and opening a saved report is a
 * link with these params. Pure.
 */

export const REPORT_KINDS = ["trend", "funnel", "retention", "revenue"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_PAGES: Record<ReportKind, { path: string; label: string }> = {
  trend: { path: "events", label: "Events" },
  funnel: { path: "funnels", label: "Funnel" },
  retention: { path: "retention", label: "Retention" },
  revenue: { path: "revenue", label: "Revenue" },
};

type Search = URLSearchParams;

function breakdownFrom(sp: Search): string | undefined {
  const by = sp.get("by") || undefined;
  const property = sp.get("property")?.trim();
  if (by === "property") return property ? `property:${property}` : undefined;
  return by;
}

function breakdownTo(q: Search, breakdown: unknown) {
  if (typeof breakdown !== "string" || !breakdown) return;
  if (breakdown.startsWith("property:")) {
    q.set("by", "property");
    q.set("property", breakdown.slice("property:".length));
  } else q.set("by", breakdown);
}

/** The report service input for a kind, from page search params. */
export function inputFromParams(kind: ReportKind, sp: Search): Record<string, unknown> {
  const common = { days: sp.get("days") ?? undefined, cohortId: sp.get("cohort") || undefined };
  switch (kind) {
    case "trend":
      return { ...common, event: sp.get("event") ?? "", breakdown: breakdownFrom(sp) };
    case "funnel":
      return {
        ...common,
        steps: sp.getAll("step").map((s) => s.trim()).filter(Boolean),
        windowDays: sp.get("window") ?? undefined,
        breakdown: sp.get("split") === "platform" ? "platform" : undefined,
      };
    case "retention":
      return { ...common, startEvent: sp.get("start") ?? "", returnEvent: sp.get("return") ?? "" };
    case "revenue":
      return { ...common, breakdown: breakdownFrom(sp) };
  }
}

/** Page search params for a saved (validated) report config. */
export function paramsFromConfig(kind: ReportKind, config: Record<string, unknown>): URLSearchParams {
  const q = new URLSearchParams();
  const str = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  };
  switch (kind) {
    case "trend":
      str("event", config.event);
      breakdownTo(q, config.breakdown);
      break;
    case "funnel":
      for (const s of Array.isArray(config.steps) ? config.steps : []) q.append("step", String(s));
      str("window", config.windowDays);
      if (config.breakdown === "platform") q.set("split", "platform");
      break;
    case "retention":
      str("start", config.startEvent);
      str("return", config.returnEvent);
      break;
    case "revenue":
      breakdownTo(q, config.breakdown);
      break;
  }
  str("days", config.days);
  str("cohort", config.cohortId);
  return q;
}

/** Search params from a Next.js `searchParams` object. */
export function toSearch(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) q.append(k, item);
  }
  return q;
}
