/**
 * Tracking-plan snapshots, version diffs and exports. Pure: the service loads
 * the rows, these functions compare and serialize them.
 */

export interface SnapshotProperty {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example: unknown;
  allowed_values: string[] | null;
}

export interface SnapshotEvent {
  event_name: string;
  display_name: string;
  description: string;
  category: string;
  trigger: string;
  source: string;
  priority: string;
  required: boolean;
  custom: boolean;
  activation_relevance: boolean;
  conversion_relevance: boolean;
  revenue_relevance: boolean;
  attribution_relevance: boolean;
  automation_relevance: boolean;
  platforms: string[];
  reason: string;
  properties: SnapshotProperty[];
}

export interface SnapshotUserProperty {
  name: string;
  type: string;
  description: string;
  source: string;
  reason: string;
}

export interface SnapshotAttributionRule {
  channel: string;
  parameters: string[];
  click_id_param: string | null;
  notes: string;
}

export interface PlanSnapshot {
  version: {
    id: string;
    version: number;
    status: string;
    generator: string;
    business_model: string | null;
    activation_event: string | null;
    north_star_event: string | null;
    created_at: Date | string;
    approved_at: Date | string | null;
    published_at: Date | string | null;
  };
  events: SnapshotEvent[];
  user_properties: SnapshotUserProperty[];
  attribution_rules: SnapshotAttributionRule[];
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface NamedChange {
  name: string;
  changes: FieldChange[];
}

export interface EventChange {
  event_name: string;
  changes: FieldChange[];
  properties: { added: SnapshotProperty[]; removed: SnapshotProperty[]; changed: NamedChange[] };
}

export interface PlanDiff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  plan: FieldChange[];
  events: { added: SnapshotEvent[]; removed: SnapshotEvent[]; changed: EventChange[] };
  user_properties: { added: SnapshotUserProperty[]; removed: SnapshotUserProperty[]; changed: NamedChange[] };
  attribution_rules: { added: SnapshotAttributionRule[]; removed: SnapshotAttributionRule[]; changed: NamedChange[] };
  /** Total number of differences; 0 means the versions define the same plan. */
  count: number;
}

const EVENT_FIELDS = [
  "display_name", "description", "category", "trigger", "source", "priority", "required", "platforms",
  "activation_relevance", "conversion_relevance", "revenue_relevance", "attribution_relevance", "automation_relevance",
] as const satisfies readonly (keyof SnapshotEvent)[];
const PROPERTY_FIELDS = ["type", "required", "description", "allowed_values", "example"] as const;
const USER_PROPERTY_FIELDS = ["type", "description", "source"] as const;
const RULE_FIELDS = ["parameters", "click_id_param", "notes"] as const;
const PLAN_FIELDS = ["business_model", "activation_event", "north_star_event"] as const;

/** Order-insensitive for arrays of scalars (platforms, allowed values), exact otherwise. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x !== "object") ? [...v].map(String).sort() : v ?? null);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function fieldChanges<T extends object>(a: T, b: T, fields: readonly (keyof T)[]): FieldChange[] {
  return fields.filter((f) => !same(a[f], b[f])).map((f) => ({ field: String(f), from: a[f] ?? null, to: b[f] ?? null }));
}

function byName<T>(rows: T[], key: (r: T) => string): Map<string, T> {
  return new Map(rows.map((r) => [key(r), r]));
}

function diffList<T extends object>(a: T[], b: T[], key: (r: T) => string, fields: readonly (keyof T)[]) {
  const ma = byName(a, key);
  const mb = byName(b, key);
  return {
    added: b.filter((r) => !ma.has(key(r))),
    removed: a.filter((r) => !mb.has(key(r))),
    changed: b
      .filter((r) => ma.has(key(r)))
      .map((r) => ({ name: key(r), changes: fieldChanges(ma.get(key(r))!, r, fields) }))
      .filter((c) => c.changes.length > 0),
  };
}

/** What changed going from version `a` to version `b`. */
export function diffPlans(a: PlanSnapshot, b: PlanSnapshot): PlanDiff {
  const ea = byName(a.events, (e) => e.event_name);
  const eb = byName(b.events, (e) => e.event_name);
  const changed: EventChange[] = [];
  for (const e of b.events) {
    const old = ea.get(e.event_name);
    if (!old) continue;
    const changes = fieldChanges(old, e, EVENT_FIELDS);
    const props = diffList(old.properties, e.properties, (p) => p.name, PROPERTY_FIELDS);
    if (changes.length || props.added.length || props.removed.length || props.changed.length) {
      changed.push({ event_name: e.event_name, changes, properties: props });
    }
  }
  const events = {
    added: b.events.filter((e) => !ea.has(e.event_name)),
    removed: a.events.filter((e) => !eb.has(e.event_name)),
    changed,
  };
  const userProperties = diffList(a.user_properties, b.user_properties, (u) => u.name, USER_PROPERTY_FIELDS);
  const rules = diffList(a.attribution_rules, b.attribution_rules, (r) => r.channel, RULE_FIELDS);
  const plan = fieldChanges(a.version, b.version, PLAN_FIELDS);
  const count =
    plan.length + events.added.length + events.removed.length +
    changed.reduce((n, c) => n + c.changes.length + c.properties.added.length + c.properties.removed.length + c.properties.changed.length, 0) +
    userProperties.added.length + userProperties.removed.length + userProperties.changed.length +
    rules.added.length + rules.removed.length + rules.changed.length;
  return {
    from: { id: a.version.id, version: a.version.version },
    to: { id: b.version.id, version: b.version.version },
    plan,
    events,
    user_properties: userProperties,
    attribution_rules: rules,
    count,
  };
}

// ── Export ──────────────────────────────────────────────────────────────────
export const PLAN_EXPORT_FORMAT = "leanapp.tracking_plan/v1";

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** The plan as a self-describing JSON document (also the management API's response body). */
export function planToJson(s: PlanSnapshot, app: { id: string; name: string }) {
  return {
    format: PLAN_EXPORT_FORMAT,
    app: { id: app.id, name: app.name },
    version: s.version.version,
    version_id: s.version.id,
    status: s.version.status,
    generator: s.version.generator,
    business_model: s.version.business_model,
    activation_event: s.version.activation_event,
    north_star_event: s.version.north_star_event,
    created_at: iso(s.version.created_at),
    approved_at: iso(s.version.approved_at),
    published_at: iso(s.version.published_at),
    events: s.events.map((e) => ({
      event_name: e.event_name,
      display_name: e.display_name,
      description: e.description,
      category: e.category,
      trigger: e.trigger,
      source: e.source,
      priority: e.priority,
      required: e.required,
      custom: e.custom,
      platforms: e.platforms,
      relevance: {
        activation: e.activation_relevance, conversion: e.conversion_relevance, revenue: e.revenue_relevance,
        attribution: e.attribution_relevance, automation: e.automation_relevance,
      },
      reason: e.reason,
      properties: e.properties.map((p) => ({
        name: p.name, type: p.type, required: p.required, description: p.description,
        allowed_values: p.allowed_values ?? null, example: p.example ?? null,
      })),
    })),
    user_properties: s.user_properties.map((u) => ({ name: u.name, type: u.type, description: u.description, source: u.source, reason: u.reason })),
    attribution_rules: s.attribution_rules.map((r) => ({ channel: r.channel, parameters: r.parameters, click_id_param: r.click_id_param, notes: r.notes })),
  };
}

export const CSV_COLUMNS = [
  "kind", "event_name", "display_name", "category", "source", "priority", "event_required", "custom",
  "property_name", "property_type", "property_required", "allowed_values", "example", "description", "trigger",
] as const;

/**
 * One cell, RFC 4180 quoted. Text that a spreadsheet would run as a formula
 * (leading = + - @ or a control character) is prefixed with ' so an exported
 * plan can't execute anything when opened.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flat CSV: one `event` row per event, one `event_property` row per property
 * (with its event's name), one `user_property` row per user property.
 */
export function planToCsv(s: PlanSnapshot): string {
  const rows: unknown[][] = [[...CSV_COLUMNS]];
  for (const e of s.events) {
    rows.push(["event", e.event_name, e.display_name, e.category, e.source, e.priority, e.required, e.custom, "", "", "", "", "", e.description, e.trigger]);
    for (const p of e.properties) {
      rows.push(["event_property", e.event_name, "", "", "", "", "", "", p.name, p.type, p.required, (p.allowed_values ?? []).join("|"), p.example ?? "", p.description, ""]);
    }
  }
  for (const u of s.user_properties) {
    rows.push(["user_property", "", "", "", u.source, "", "", "", u.name, u.type, "", "", "", u.description, ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
