import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { AppError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { COUNTED_EVENTS } from "@/modules/analytics/sql";
import { audit } from "@/modules/audit/service";
import type { Permission } from "@/modules/rbac/permissions";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

/**
 * The property catalog: one list of the user and event properties a project
 * has, shared by every surface that names a property (Settings → Dev Ops →
 * Attributes, Users filters and columns, Audience conditions, Analytics
 * filters and breakdowns). Nothing else keeps its own list.
 *
 * Each entry merges three sources:
 * - Observed: what the environment's data actually carries. User properties
 *   come from the most recently seen user profiles, event properties from the
 *   most recent counted events of the last 30 days (both sampled, so the
 *   catalog stays fast however much data there is).
 * - Tracking plan: the published plan version (else the newest draft), with
 *   its types, descriptions, allowed values and the events that carry each
 *   event property.
 * - Descriptions people wrote in Attributes (platform.property_definitions,
 *   per project, shared by its environments).
 *
 * Built-in event attributes the SDK collects on every event (platform, app
 * version, OS version, country) are listed too, marked built in.
 */

export type PropertyScope = "user" | "event";
export const SCOPES: PropertyScope[] = ["user", "event"];

export interface CatalogProperty {
  scope: PropertyScope;
  name: string;
  /** The plan's type when the plan has it, else the type seen most in the data. */
  type: string;
  /** Types seen in the data (most frequent first); more than one means senders disagree. */
  observedTypes: string[];
  description: string;
  descriptionFrom: "custom" | "plan" | "built_in" | null;
  /** The description people wrote in Attributes (empty when none). */
  customDescription: string;
  /** Collected by the SDK on every event (not in `properties`). */
  builtIn: boolean;
  /** How the property reaches LeanApp. */
  source: string;
  /** The SDK call or field that sets it. */
  sdk: string;
  plan: { type: string; required: boolean; events: string[]; allowedValues: string[] | null } | null;
  /** The plan's type and the data's type don't match. */
  typeMismatch: boolean;
  /** Rows in the sample that carry the property (users or events). */
  seen: number;
  lastSeen: Date | null;
  /** Events this property was seen on (event properties; up to 10). */
  events: string[];
  /** The most frequent observed values (up to 10), else the plan's allowed values. */
  values: { value: string; count: number | null }[];
}

export interface Catalog {
  user: CatalogProperty[];
  event: CatalogProperty[];
  /** Sample sizes behind `seen`. */
  sample: { users: number; events: number; eventDays: number };
  planVersion: number | null;
}

export const USER_SAMPLE = 5000;
export const EVENT_SAMPLE = 20000;
export const EVENT_DAYS = 30;
const TOP_VALUES = 10;

const BUILT_IN: { name: string; description: string; sdk: string; column: string }[] = [
  { name: "platform", description: "The platform the event came from (ios, android, web…).", sdk: "Set by the SDK (context.platform)", column: "e.platform" },
  { name: "app_version", description: "Version of the app that sent the event.", sdk: "Set by the SDK (context.app_version)", column: "e.app_version" },
  { name: "os_version", description: "Operating system version of the device.", sdk: "Set by the SDK (context.os_version)", column: "e.os_version" },
  { name: "country", description: "Country of the device, from its locale or location.", sdk: "Set by the SDK (context.location.country)", column: "coalesce(e.context->'location'->>'country', e.context->>'country')" },
];
export const BUILT_IN_EVENT_ATTRIBUTES = BUILT_IN.map((b) => b.name);

const SOURCE_LABEL: Record<string, string> = {
  mobile_sdk: "App (SDK)",
  backend: "Server (API)",
  both: "App and server",
  automatic: "Automatic",
  computed: "Computed",
};

/** Plan types and data types that mean the same thing. */
const COMPATIBLE: Record<string, string> = { integer: "number", number: "number", currency: "string", datetime: "string", string: "string", boolean: "boolean", array: "array", object: "object" };

interface Observed {
  name: string;
  types: string[];
  seen: number;
  lastSeen: Date | null;
  events: string[];
}

async function observedKeys(db: Db, sample: string, params: unknown[], col: string, tsCol: string, evCol: string | null): Promise<Observed[]> {
  const rows = await db.query<{ name: string; type: string; n: number; last_seen: Date | null; events: string[] | null }>(
    `with ${sample}
     select k.key as name, jsonb_typeof(k.value) as type, count(*)::int as n, max(${tsCol}) as last_seen,
            ${evCol ? `(array_agg(distinct ${evCol}))[1:10]` : "null::text[]"} as events
       from s cross join lateral jsonb_each(case when jsonb_typeof(${col}) = 'object' then ${col} else '{}'::jsonb end) k
      where jsonb_typeof(k.value) <> 'null'
      group by 1, 2
      order by 1, 3 desc`,
    params,
  );
  const byName = new Map<string, Observed>();
  for (const r of rows) {
    const o = byName.get(r.name) ?? { name: r.name, types: [], seen: 0, lastSeen: null, events: [] };
    o.types.push(r.type);
    o.seen += r.n;
    if (r.last_seen && (!o.lastSeen || r.last_seen > o.lastSeen)) o.lastSeen = r.last_seen;
    for (const e of r.events ?? []) if (!o.events.includes(e) && o.events.length < 10) o.events.push(e);
    byName.set(r.name, o);
  }
  return [...byName.values()];
}

async function observedValues(db: Db, sample: string, pairs: string, params: unknown[]): Promise<Map<string, { value: string; count: number }[]>> {
  const rows = await db.query<{ name: string; val: string; n: number }>(
    `with ${sample}, v as (${pairs})
     select name, val, n from (
       select name, val, count(*)::int as n, row_number() over (partition by name order by count(*) desc, val) as rn
         from v where val is not null and val <> '' and char_length(val) <= 100 group by 1, 2) x
      where rn <= ${TOP_VALUES}
      order by name, n desc, val`,
    params,
  );
  const out = new Map<string, { value: string; count: number }[]>();
  for (const r of rows) out.set(r.name, [...(out.get(r.name) ?? []), { value: r.val, count: r.n }]);
  return out;
}

const scalarPairs = (col: string) => `select k.key as name, k.value #>> '{}' as val
  from s cross join lateral jsonb_each(case when jsonb_typeof(${col}) = 'object' then ${col} else '{}'::jsonb end) k
 where jsonb_typeof(k.value) in ('string', 'number', 'boolean')`;

interface PlanProp { name: string; type: string; required: boolean; description: string; source: string | null; events: string[]; allowedValues: string[] | null }

async function planProperties(db: Db, appId: string): Promise<{ version: number | null; user: PlanProp[]; event: PlanProp[] }> {
  const v = await db.one<{ id: string; version: number }>(
    `select v.id, v.version from platform.tracking_plans t
       join platform.tracking_plan_versions v on v.tracking_plan_id = t.id
      where t.app_id = $1 and v.status <> 'archived'
      order by (v.id = t.published_version_id) desc, v.version desc limit 1`,
    [appId],
  );
  if (!v) return { version: null, user: [], event: [] };
  const user = await db.query<PlanProp>(
    `select name, type, false as required, description, source, '{}'::text[] as events, null as "allowedValues"
       from platform.tracking_user_properties where plan_version_id = $1 order by name`,
    [v.id],
  );
  const event = await db.query<PlanProp>(
    `select p.name, (array_agg(p.type order by p.required desc, e.sort_order))[1] as type, bool_or(p.required) as required,
            (array_agg(p.description order by p.required desc, e.sort_order))[1] as description,
            null as source, array_agg(distinct e.event_name) as events,
            (array_agg(p.allowed_values order by p.required desc, e.sort_order) filter (where p.allowed_values is not null))[1] as "allowedValues"
       from platform.tracking_event_properties p
       join platform.tracking_events e on e.id = p.tracking_event_id
      where e.plan_version_id = $1
      group by p.name order by p.name`,
    [v.id],
  );
  return { version: v.version, user, event };
}

function merge(
  scope: PropertyScope,
  observed: Observed[],
  values: Map<string, { value: string; count: number }[]>,
  plan: PlanProp[],
  custom: Map<string, string>,
): CatalogProperty[] {
  const names = new Set([...observed.map((o) => o.name), ...plan.map((p) => p.name), ...custom.keys()]);
  const out: CatalogProperty[] = [];
  for (const name of names) {
    const o = observed.find((x) => x.name === name);
    const p = plan.find((x) => x.name === name);
    const customDescription = custom.get(name) ?? "";
    const observedType = o?.types[0];
    const type = p?.type ?? observedType ?? "string";
    const description = customDescription || p?.description || "";
    out.push({
      scope,
      name,
      type,
      observedTypes: o?.types ?? [],
      description,
      descriptionFrom: customDescription ? "custom" : p?.description ? "plan" : null,
      customDescription,
      builtIn: false,
      source: p?.source ? (SOURCE_LABEL[p.source] ?? p.source) : "App or server",
      sdk: scope === "user" ? "identify(userId, traits) or setUserProperties(…)" : "track(event, properties)",
      plan: p ? { type: p.type, required: p.required, events: p.events, allowedValues: p.allowedValues } : null,
      typeMismatch: Boolean(p && observedType && (COMPATIBLE[p.type] ?? p.type) !== observedType),
      seen: o?.seen ?? 0,
      lastSeen: o?.lastSeen ?? null,
      events: o?.events ?? [],
      values: values.get(name) ?? (p?.allowedValues ?? []).map((value) => ({ value, count: null })),
    });
  }
  return out.sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name));
}

/**
 * The catalog for one environment of a project. `permission` is the one the
 * calling surface already requires (each surface keeps its own access rule).
 */
export async function propertyCatalog(
  ctx: TenantContext,
  scope: { appId: string; environmentId: string },
  permission: Permission,
  opts: { only?: PropertyScope } = {},
): Promise<Catalog> {
  const wantUser = opts.only !== "event";
  const wantEvent = opts.only !== "user";
  return tenantTx(ctx, permission, async (db) => {
    const env = await db.one<{ id: string }>("select id from platform.environments where id = $1 and app_id = $2", [scope.environmentId, scope.appId]);
    if (!env) throw new NotFoundError("Environment not found.");
    await db.query("set local statement_timeout = '10s'");
    const params = [env.id];
    const userSample = `s as (select u.properties, u.last_seen_at from platform.app_users u
                              where u.environment_id = $1 order by u.last_seen_at desc limit ${USER_SAMPLE})`;
    const eventSample = `s as (select coalesce(e.canonical_name, e.event_name) as ev, e.properties, e."timestamp" as ts,
                                      ${BUILT_IN.map((b) => `${b.column} as ${b.name}`).join(", ")}
                                 from platform.events e
                                where e.environment_id = $1 and e."timestamp" >= now() - interval '${EVENT_DAYS} days' and ${COUNTED_EVENTS}
                                order by e."timestamp" desc limit ${EVENT_SAMPLE})`;
    const none = new Map<string, { value: string; count: number }[]>();

    const userKeys = wantUser ? await observedKeys(db, userSample, params, "s.properties", "s.last_seen_at", null) : [];
    const userValues = wantUser ? await observedValues(db, userSample, scalarPairs("s.properties"), params) : none;
    const eventKeys = wantEvent ? await observedKeys(db, eventSample, params, "s.properties", "s.ts", "s.ev") : [];
    const eventValues = wantEvent ? await observedValues(db, eventSample, scalarPairs("s.properties"), params) : none;
    const builtInValues = wantEvent
      ? await observedValues(db, eventSample, BUILT_IN.map((b) => `select '${b.name}' as name, s.${b.name} as val from s`).join(" union all "), params)
      : none;
    const counts = await db.one<{ users: number; events: number }>(
      `select (select count(*)::int from (select 1 from platform.app_users where environment_id = $1 limit ${USER_SAMPLE}) u) as users,
              (select count(*)::int from (select 1 from platform.events e where e.environment_id = $1 and e."timestamp" >= now() - interval '${EVENT_DAYS} days' and ${COUNTED_EVENTS} limit ${EVENT_SAMPLE}) x) as events`,
      params,
    );
    const plan = await planProperties(db, scope.appId);
    const defs = await db.query<{ scope: PropertyScope; name: string; description: string }>(
      "select scope, name, description from platform.property_definitions where app_id = $1 and description <> ''",
      [scope.appId],
    );
    const custom = (s: PropertyScope) => new Map(defs.filter((d) => d.scope === s).map((d) => [d.name, d.description]));
    const eventCustom = custom("event");
    const builtIn: CatalogProperty[] = BUILT_IN.map((b) => {
      const values = builtInValues.get(b.name) ?? [];
      const customDescription = eventCustom.get(b.name) ?? "";
      eventCustom.delete(b.name);
      return {
        scope: "event",
        name: b.name,
        type: "string",
        observedTypes: values.length ? ["string"] : [],
        description: customDescription || b.description,
        descriptionFrom: customDescription ? "custom" : "built_in",
        customDescription,
        builtIn: true,
        source: "Automatic",
        sdk: b.sdk,
        plan: null,
        typeMismatch: false,
        seen: values.reduce((n, v) => n + v.count, 0),
        lastSeen: null,
        events: [],
        values,
      };
    });
    return {
      user: wantUser ? merge("user", userKeys, userValues, plan.user, custom("user")) : [],
      event: wantEvent ? [...builtIn, ...merge("event", eventKeys.filter((k) => !BUILT_IN_EVENT_ATTRIBUTES.includes(k.name)), eventValues, plan.event, eventCustom)] : [],
      sample: { users: counts?.users ?? 0, events: counts?.events ?? 0, eventDays: EVENT_DAYS },
      planVersion: plan.version,
    };
  });
}

/**
 * The catalog for pickers (Users, Analytics, Audiences): suggestions only, so
 * a slow or failed catalog query leaves the page working without them.
 * Permission and not-found errors still throw.
 */
export async function catalogForPickers(...args: Parameters<typeof propertyCatalog>): Promise<Catalog> {
  try {
    return await propertyCatalog(...args);
  } catch (err) {
    if (err instanceof AppError) throw err;
    log.warn("properties.catalog_failed", { error: err, environment_id: args[1].environmentId });
    return { user: [], event: [], sample: { users: 0, events: 0, eventDays: EVENT_DAYS }, planVersion: null };
  }
}

const describeSchema = z.object({
  scope: z.enum(["user", "event"]),
  name: z.string().trim().regex(/^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$/, "Not a property name."),
  description: z.string().trim().max(500, "Keep the description under 500 characters."),
});

/** Sets (or clears, with an empty text) the description of a property, for every environment of the project. */
export async function describeProperty(ctx: TenantContext, appId: string, input: unknown): Promise<void> {
  const r = describeSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid description.");
  const { scope, name, description } = r.data;
  await tenantTx(ctx, "implementation.edit", async (db) => {
    const app = await db.one<{ id: string }>("select id from platform.apps where id = $1", [appId]);
    if (!app) throw new NotFoundError("Project not found.");
    const before = await db.one<{ description: string }>("select description from platform.property_definitions where app_id = $1 and scope = $2 and name = $3", [appId, scope, name]);
    if ((before?.description ?? "") === description) return;
    await db.query(
      `insert into platform.property_definitions (organization_id, app_id, scope, name, description, updated_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (app_id, scope, name) do update set description = excluded.description, updated_by = excluded.updated_by, updated_at = now()`,
      [ctx.organizationId, appId, scope, name, description, ctx.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "property.described", targetType: "app", targetId: appId,
      metadata: { scope, name, from: before?.description ?? "", to: description },
    });
  });
}

/** Names and observed values, the shape pickers need (Users, Audiences, Analytics). */
export interface PropertyOption {
  name: string;
  type: string;
  description: string;
  values: string[];
  /** Event properties: the events it was seen on, or is planned for. */
  events?: string[];
}

export function options(list: CatalogProperty[], opts: { includeBuiltIn?: boolean } = {}): PropertyOption[] {
  return list
    .filter((p) => opts.includeBuiltIn || !p.builtIn)
    .map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      values: p.values.map((v) => v.value),
      ...(p.scope === "event" ? { events: [...new Set([...p.events, ...(p.plan?.events ?? [])])] } : {}),
    }));
}
