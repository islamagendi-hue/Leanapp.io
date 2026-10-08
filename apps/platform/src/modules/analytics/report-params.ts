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

/**
 * Range settings from page search params: `days` is a preset (7, 30, 90) or
 * "custom", which uses `from` and `to`; `compare=1` adds the previous period.
 * The dates are ignored unless the range is custom, so switching back to a
 * preset never keeps old dates.
 */
export function rangeFromParams(sp: Search): { days?: string; from?: string; to?: string; compare?: boolean } {
  const days = sp.get("days") || undefined;
  const custom = days === "custom";
  return {
    days: custom ? undefined : days,
    from: custom ? sp.get("from") || undefined : undefined,
    to: custom ? sp.get("to") || undefined : undefined,
    compare: sp.get("compare") === "1" || undefined,
  };
}

/** The report service input for a kind, from page search params. */
export function inputFromParams(kind: ReportKind, sp: Search): Record<string, unknown> {
  const common = { ...rangeFromParams(sp), cohortId: sp.get("cohort") || undefined };
  const interval = sp.get("interval") || undefined;
  switch (kind) {
    case "trend":
      return { ...common, event: sp.get("event") ?? "", breakdown: breakdownFrom(sp), interval };
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
      return { ...common, breakdown: breakdownFrom(sp), interval };
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
      str("interval", config.interval);
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
      str("interval", config.interval);
      break;
  }
  if (config.from && config.to) {
    q.set("days", "custom");
    str("from", config.from);
    str("to", config.to);
  } else str("days", config.days);
  if (config.compare === true) q.set("compare", "1");
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
