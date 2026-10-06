/**
 * Implementation Score: how much of the approved tracking plan is actually
 * implemented and valid in one environment. Pure function of observed facts,
 * so it is reproducible and unit-tested.
 *
 * Components with nothing planned are "not applicable" and excluded from the
 * weighted total rather than counted as 100%.
 */

export interface ScoreEvent {
  event_name: string;
  source: "mobile_sdk" | "backend" | "both" | "automatic";
  priority: "critical" | "high" | "medium" | "low";
  required: boolean;
  revenue_relevance: boolean;
  automation_relevance: boolean;
  status: { received: number; valid: number; invalid: number; sources: string[] } | null;
}

export interface ScoreInput {
  events: ScoreEvent[];
  plannedUserProperties: string[];
  observedUserProperties: string[];
  plannedAttributionParameters: string[];
  observedAttributionParameters: string[];
  lastEventAt: Date | null;
  now: Date;
}

export type ComponentKey = "sdk_connection" | "core_events" | "revenue_events" | "user_properties" | "attribution" | "backend_events" | "automation_readiness";

export interface ScoreComponent {
  key: ComponentKey;
  label: string;
  score: number | null; // 0–100, null = not applicable
  weight: number;
  detail: string;
}

export interface ImplementationScore {
  overall: number;
  components: ScoreComponent[];
  expected: number;
  implemented: number;
  validated: number;
  missing: string[];
  missingCritical: string[];
  failing: string[];
}

const WEIGHTS: Record<ComponentKey, number> = {
  sdk_connection: 15,
  core_events: 25,
  revenue_events: 20,
  user_properties: 10,
  attribution: 10,
  backend_events: 10,
  automation_readiness: 10,
};

const LABELS: Record<ComponentKey, string> = {
  sdk_connection: "SDK connection",
  core_events: "Core events",
  revenue_events: "Revenue events",
  user_properties: "User properties",
  attribution: "Attribution",
  backend_events: "Backend events",
  automation_readiness: "Automation readiness",
};

/** An event counts fully when valid payloads arrive; half when received but every payload failed validation. */
function eventCredit(e: ScoreEvent): number {
  if (!e.status || e.status.received === 0) return 0;
  return e.status.valid > 0 ? 1 : 0.5;
}

function pct(events: ScoreEvent[]): number | null {
  if (!events.length) return null;
  return Math.round((events.reduce((s, e) => s + eventCredit(e), 0) / events.length) * 100);
}

export function computeScore(input: ScoreInput): ImplementationScore {
  const { events } = input;
  const ageMs = input.lastEventAt ? input.now.getTime() - input.lastEventAt.getTime() : Infinity;
  const sdk = !input.lastEventAt ? 0 : ageMs <= 7 * 86_400_000 ? 100 : 50;

  const required = events.filter((e) => e.required);
  const core = required.filter((e) => !e.revenue_relevance && e.source !== "backend");
  const revenue = events.filter((e) => e.revenue_relevance && e.required);
  const backend = events.filter((e) => e.source === "backend" && e.required);
  const automation = events.filter((e) => e.automation_relevance && e.required);

  const upPlanned = new Set(input.plannedUserProperties);
  const upSeen = input.observedUserProperties.filter((p) => upPlanned.has(p));
  const attrPlanned = new Set(input.plannedAttributionParameters);
  const attrSeen = input.observedAttributionParameters.filter((p) => attrPlanned.has(p));

  // Backend events only count if they actually arrived from a server (secret key).
  const backendPct = backend.length
    ? Math.round((backend.filter((e) => e.status?.sources.includes("backend") && (e.status?.valid ?? 0) > 0).length / backend.length) * 100)
    : null;

  const raw: Record<ComponentKey, [number | null, string]> = {
    sdk_connection: [sdk, !input.lastEventAt ? "No events received yet." : sdk === 100 ? "Events received in the last 7 days." : "No events in the last 7 days."],
    core_events: [pct(core), `${core.filter((e) => eventCredit(e) === 1).length}/${core.length} required app events valid.`],
    revenue_events: [pct(revenue), revenue.length ? `${revenue.filter((e) => eventCredit(e) === 1).length}/${revenue.length} revenue events valid.` : "No revenue events planned."],
    user_properties: [upPlanned.size ? Math.round((upSeen.length / upPlanned.size) * 100) : null, `${upSeen.length}/${upPlanned.size} planned user properties seen.`],
    attribution: [attrPlanned.size ? Math.round((attrSeen.length / attrPlanned.size) * 100) : null, attrPlanned.size ? `${attrSeen.length}/${attrPlanned.size} attribution parameters seen.` : "No attribution rules planned."],
    backend_events: [backendPct, backend.length ? `${backend.filter((e) => e.status?.sources.includes("backend") && (e.status?.valid ?? 0) > 0).length}/${backend.length} backend events received from a server.` : "No backend events planned."],
    automation_readiness: [pct(automation), `${automation.filter((e) => eventCredit(e) === 1).length}/${automation.length} automation trigger events valid.`],
  };

  const components: ScoreComponent[] = (Object.keys(WEIGHTS) as ComponentKey[]).map((key) => ({
    key,
    label: LABELS[key],
    score: raw[key][0],
    weight: WEIGHTS[key],
    detail: raw[key][1],
  }));
  const applicable = components.filter((c) => c.score !== null);
  const totalWeight = applicable.reduce((s, c) => s + c.weight, 0) || 1;
  const overall = Math.round(applicable.reduce((s, c) => s + (c.score as number) * c.weight, 0) / totalWeight);

  const implemented = events.filter((e) => (e.status?.received ?? 0) > 0);
  const validated = events.filter((e) => (e.status?.valid ?? 0) > 0);
  const missing = events.filter((e) => !e.status || e.status.received === 0);
  return {
    overall,
    components,
    expected: events.length,
    implemented: implemented.length,
    validated: validated.length,
    missing: missing.map((e) => e.event_name),
    missingCritical: missing.filter((e) => e.priority === "critical").map((e) => e.event_name),
    failing: events.filter((e) => e.status && e.status.received > 0 && e.status.valid === 0).map((e) => e.event_name),
  };
}
