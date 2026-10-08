/**
 * Audience definitions: a boolean condition tree (AND / OR / NOT) over people,
 * compiled to one parameterized SQL query.
 *
 * Safety: every user-supplied value (event names, property names, values,
 * numbers) becomes a bind parameter. The only things spliced into SQL text are
 * fixed fragments chosen from whitelisted enums (operators, leaf kinds) and
 * generated identifiers (CTE names, $n placeholders). Property names are also
 * restricted to a conservative pattern, as a second line of defense.
 *
 * People follow the analytics identity rule (see analytics PERSON): a person
 * is the user_id; an install linked to exactly one user belongs to that user;
 * an install linked to none or to several users (a shared device) is its own
 * anonymous person "anon:<anonymous_id>". Shared devices are never merged.
 * Event conditions count events by the analytics counting rule (COUNTED_EVENTS),
 * so an audience used as a report filter agrees with the report's numbers.
 *
 * Pure module (no database access) so it can be unit tested.
 */
import { z } from "zod";
import { COUNTED_EVENTS } from "@/modules/analytics/sql";

// ── Schema ──────────────────────────────────────────────────────────────────
export const PROPERTY_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "exists", "not_exists"] as const;
export type PropertyOp = (typeof PROPERTY_OPS)[number];
export const NUMERIC_OPS: readonly PropertyOp[] = ["gt", "gte", "lt", "lte"];
export const COUNT_OPS = ["gte", "eq", "lte"] as const;
export const AMOUNT_OPS = ["gte", "gt", "lte", "lt", "eq"] as const;
export const PLATFORMS = ["android", "ios", "web", "react_native", "flutter", "backend"] as const;

const propertyName = z.string().trim().regex(/^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$/, "Property names may use letters, digits, _ . $ - (max 64).");
const eventName = z.string().trim().min(1, "Choose an event.").max(200);
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const propertyFilterSchema = z
  .object({
    property: propertyName,
    op: z.enum(PROPERTY_OPS),
    value: z.union([scalar, z.array(z.string().max(200)).min(1).max(50)]).optional(),
  })
  .superRefine((f, ctx) => {
    const v = f.value;
    if (f.op === "exists" || f.op === "not_exists") return;
    if (v === undefined || v === "") ctx.addIssue({ code: "custom", message: `Give a value for ${f.property}.` });
    else if (NUMERIC_OPS.includes(f.op) && typeof v !== "number") ctx.addIssue({ code: "custom", message: `${f.property}: "${f.op}" needs a number.` });
    else if (f.op === "in" && !Array.isArray(v)) ctx.addIssue({ code: "custom", message: `${f.property}: "in" needs a list of values.` });
    else if (f.op !== "in" && Array.isArray(v)) ctx.addIssue({ code: "custom", message: `${f.property}: only "in" takes a list.` });
  });
export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

const days = z.coerce.number().int().min(1).max(365);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.").refine((s) => !Number.isNaN(Date.parse(s)), "Not a valid date.");
/** Calendar days, both included, in the project's timezone. */
export const dateRangeSchema = z.object({ from: isoDate, to: isoDate }).refine((r) => r.from <= r.to, "The start date must be on or before the end date.");

export const eventLeafSchema = z.object({
  type: z.literal("event"),
  event: eventName,
  /** false: did not do the event (in the window, matching the filters). */
  did: z.boolean().default(true),
  countOp: z.enum(COUNT_OPS).default("gte"),
  count: z.coerce.number().int().min(1).max(1_000_000).default(1),
  withinDays: days.default(30),
  /** Between two dates instead of the last `withinDays` days. */
  between: dateRangeSchema.optional(),
  /** Automations only: count events since the run was triggered instead of the last N days. */
  sinceTrigger: z.boolean().optional(),
  where: z.array(propertyFilterSchema).max(5).default([]),
});
export const userPropertyLeafSchema = z.object({ type: z.literal("user_property") }).and(propertyFilterSchema);
export const seenLeafSchema = z.object({
  type: z.enum(["first_seen", "last_seen"]),
  op: z.enum(["within_days", "before_days"]),
  days,
});
export const platformLeafSchema = z.object({ type: z.literal("platform"), platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length) });
export const revenueLeafSchema = z.object({
  type: z.literal("revenue"),
  op: z.enum(AMOUNT_OPS),
  amount: z.coerce.number().finite().min(0).max(1e12),
  withinDays: days.default(90),
  /** Restrict to these events; empty = every event carrying the revenue property. */
  events: z.array(eventName).max(10).default([]),
  property: propertyName.default("revenue"),
});

export type EventLeaf = z.infer<typeof eventLeafSchema>;
export type UserPropertyLeaf = z.infer<typeof userPropertyLeafSchema>;
export type SeenLeaf = z.infer<typeof seenLeafSchema>;
export type PlatformLeaf = z.infer<typeof platformLeafSchema>;
export type RevenueLeaf = z.infer<typeof revenueLeafSchema>;
export type Leaf = EventLeaf | UserPropertyLeaf | SeenLeaf | PlatformLeaf | RevenueLeaf;
export type GroupNode = { type: "and" | "or"; children: AudienceNode[] };
export type NotNode = { type: "not"; child: AudienceNode };
export type AudienceNode = Leaf | GroupNode | NotNode;

export const MAX_DEPTH = 5;
export const MAX_LEAVES = 20;

const nodeSchema: z.ZodType<AudienceNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.enum(["and", "or"]), children: z.array(nodeSchema).min(1, "A group needs at least one condition.").max(MAX_LEAVES) }),
    z.object({ type: z.literal("not"), child: nodeSchema }),
    eventLeafSchema,
    userPropertyLeafSchema,
    seenLeafSchema,
    platformLeafSchema,
    revenueLeafSchema,
  ]),
) as z.ZodType<AudienceNode>;

function walk(n: AudienceNode, depth: number, visit: (leaf: Leaf, depth: number) => void) {
  if (n.type === "and" || n.type === "or") n.children.forEach((c) => walk(c, depth + 1, visit));
  else if (n.type === "not") walk(n.child, depth + 1, visit);
  else visit(n as Leaf, depth);
}

export function leaves(n: AudienceNode): Leaf[] {
  const out: Leaf[] = [];
  walk(n, 0, (l) => out.push(l));
  return out;
}

/** Parses and checks a definition; `allowSinceTrigger` only inside automations. Throws a readable message. */
export function parseDefinition(input: unknown, opts: { allowSinceTrigger?: boolean } = {}): AudienceNode {
  const r = nodeSchema.safeParse(input);
  if (!r.success) {
    throw new DefinitionError(firstMessage(r.error.issues) ?? "The condition is not valid.");
  }
  let maxDepth = 0;
  let count = 0;
  walk(r.data, 0, (leaf, d) => {
    maxDepth = Math.max(maxDepth, d);
    count++;
    if (leaf.type === "event" && leaf.sinceTrigger && !opts.allowSinceTrigger) throw new DefinitionError('"Since the trigger" is only available in automation conditions.');
    if (leaf.type === "event" && leaf.sinceTrigger && leaf.between) throw new DefinitionError('Choose either "since the trigger" or a date range.');
  });
  if (maxDepth > MAX_DEPTH) throw new DefinitionError(`Conditions can be nested at most ${MAX_DEPTH} levels deep.`);
  if (count > MAX_LEAVES) throw new DefinitionError(`Use at most ${MAX_LEAVES} conditions.`);
  return r.data;
}

export class DefinitionError extends Error {}

type Issue = { code: string; message: string; errors?: Issue[][] };
/** The most specific message in a (possibly nested union) issue list: our own checks first. */
function firstMessage(issues: readonly Issue[]): string | null {
  const all: Issue[] = [];
  const collect = (list: readonly Issue[]) => list.forEach((i) => (i.errors ? i.errors.forEach(collect) : all.push(i)));
  collect(issues);
  const custom = all.find((i) => i.code === "custom");
  if (custom) return custom.message;
  const specific = all.find((i) => i.code !== "invalid_union" && i.code !== "invalid_value" && !/^Invalid input/.test(i.message));
  return specific?.message ?? null;
}

// ── Compiler ────────────────────────────────────────────────────────────────
/** Bind values collected while compiling; `add` returns the placeholder. Same shape as the analytics Params. */
export interface ParamSink {
  readonly values: unknown[];
  add(v: unknown): string;
}

class Params implements ParamSink {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** Numeric value of a jsonb property: numbers, or strings that look like numbers; else null. Never throws. */
function numeric(col: string, key: string): string {
  return `(case when jsonb_typeof(${col}->${key}) = 'number' then (${col}->>${key})::numeric
                when (${col}->>${key}) ~ '^-?[0-9]{1,15}([.][0-9]{1,10})?$' then (${col}->>${key})::numeric end)`;
}

const CMP: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** Predicate for one property filter on a jsonb column expression (a fixed, trusted string). */
export function propertyPredicate(col: string, f: PropertyFilter, p: ParamSink): string {
  const key = p.add(f.property);
  const text = `(${col}->>${key})`;
  switch (f.op) {
    case "exists":
      return `(jsonb_typeof(${col}->${key}) is not null and jsonb_typeof(${col}->${key}) <> 'null')`;
    case "not_exists":
      return `(jsonb_typeof(${col}->${key}) is null or jsonb_typeof(${col}->${key}) = 'null')`;
    case "eq":
    case "neq": {
      const v = f.value as string | number | boolean;
      const same = typeof v === "number" ? `${numeric(col, key)} = ${p.add(v)}::numeric` : `${text} = ${p.add(String(v))}::text`;
      return f.op === "eq" ? `coalesce(${same}, false)` : `not coalesce(${same}, false)`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return `coalesce(${numeric(col, key)} ${CMP[f.op]} ${p.add(f.value)}::numeric, false)`;
    case "contains":
      return `coalesce(strpos(lower(${text}), lower(${p.add(String(f.value))}::text)) > 0, false)`;
    case "not_contains":
      return `not coalesce(strpos(lower(${text}), lower(${p.add(String(f.value))}::text)) > 0, false)`;
    case "in":
      return `coalesce(${text} = any(${p.add(f.value)}::text[]), false)`;
  }
}

/**
 * The person of an events row aliased `e` (same rule as analytics PERSON, kept
 * in sync by a test). `solo` maps an install to its one linked user.
 */
const PERSON_EXPR = "coalesce(e.user_id, s.user_id, 'anon:' || e.anonymous_id)";
const PERSON_JOIN = "left join solo s on e.user_id is null and s.anonymous_id = e.anonymous_id";

export interface CompileOptions {
  /** Evaluate for one person only (automation branch conditions). */
  personKey?: string;
  /** Start of "since the trigger" windows. */
  triggerAt?: Date;
  /** Timezone of date-range windows (the project's). Default UTC. */
  timezone?: string;
  /**
   * Bind values to add to, when the audience is embedded in a larger query
   * (analytics reports). Its $1 must already be the environment id.
   */
  params?: ParamSink;
}

export interface Compiled {
  /** A query returning one column `person`. $1 is the environment id. */
  sql: string;
  params: unknown[];
}

/**
 * The people of an environment as CTEs `solo`, `user_installs` and `people`
 * (person, props, first_seen_at, last_seen_at, platforms). $1 is the
 * environment id; `person` (a placeholder) limits it to one person.
 * Identified users take the earliest / latest of their profile and the
 * installs linked only to them; other installs are anonymous people.
 */
export function peopleCtes(person?: string | null): string {
  return `solo as (
      select anonymous_id, min(user_id) as user_id from platform.identity_links
       where environment_id = $1 group by anonymous_id having count(*) = 1),
    user_installs as (
      select s.user_id, min(a.first_seen_at) as first_seen_at, max(a.last_seen_at) as last_seen_at,
             array_remove(array_agg(distinct a.platform), null) as platforms
        from solo s join platform.anonymous_users a on a.environment_id = $1 and a.anonymous_id = s.anonymous_id
       group by s.user_id),
    people as (
      select u.external_id as person, u.properties as props,
             least(u.first_seen_at, i.first_seen_at) as first_seen_at, greatest(u.last_seen_at, i.last_seen_at) as last_seen_at,
             coalesce(i.platforms, '{}') as platforms
        from platform.app_users u left join user_installs i on i.user_id = u.external_id
       where u.environment_id = $1${person ? ` and u.external_id = ${person}` : ""}
      union all
      select 'anon:' || a.anonymous_id, coalesce(a.first_context->'traits', '{}'::jsonb), a.first_seen_at, a.last_seen_at,
             array_remove(array[a.platform], null)
        from platform.anonymous_users a
       where a.environment_id = $1 and not exists (select 1 from solo s where s.anonymous_id = a.anonymous_id)${person ? ` and 'anon:' || a.anonymous_id = ${person}` : ""})`;
}

/**
 * Compiles a definition into `select person from …` for one environment.
 * People with a pending deletion request are always excluded.
 */
export function compileAudience(def: AudienceNode, environmentId: string, opts: CompileOptions = {}): Compiled {
  let p: ParamSink;
  if (opts.params) {
    if (opts.params.values[0] !== environmentId) throw new Error("compileAudience: $1 must be the environment id.");
    p = opts.params;
  } else {
    p = new Params();
    p.add(environmentId); // $1
  }
  const ctes: string[] = [];
  const joins: string[] = [];
  const person = opts.personKey !== undefined ? p.add(opts.personKey) : null;

  const window = (leaf: { withinDays: number; sinceTrigger?: boolean; between?: { from: string; to: string } }) => {
    if (leaf.sinceTrigger) {
      if (!opts.triggerAt) throw new DefinitionError('"Since the trigger" needs a trigger time.');
      return `e."timestamp" >= ${p.add(opts.triggerAt.toISOString())}::timestamptz`;
    }
    if (leaf.between) {
      const tz = p.add(opts.timezone ?? "UTC");
      return `e."timestamp" >= (${p.add(leaf.between.from)}::date::timestamp at time zone ${tz}::text)
             and e."timestamp" < ((${p.add(leaf.between.to)}::date + 1)::timestamp at time zone ${tz}::text)`;
    }
    return `e."timestamp" >= now() - make_interval(days => ${p.add(leaf.withinDays)}::int)`;
  };
  const personFilter = person ? ` and ${PERSON_EXPR} = ${person}` : "";

  const compileNode = (n: AudienceNode): string => {
    switch (n.type) {
      case "and":
      case "or":
        return `(${n.children.map(compileNode).join(n.type === "and" ? " and " : " or ")})`;
      case "not":
        return `(not ${compileNode(n.child)})`;
      case "event": {
        const alias = `c${ctes.length + 1}`;
        const filters = n.where.map((f) => ` and ${propertyPredicate("e.properties", f, p)}`).join("");
        ctes.push(`${alias} as (
          select ${PERSON_EXPR} as person, count(*) as n
            from platform.events e ${PERSON_JOIN}
           where e.environment_id = $1 and ${COUNTED_EVENTS} and coalesce(e.user_id, e.anonymous_id) is not null
             and coalesce(e.canonical_name, e.event_name) = ${p.add(n.event)}::text
             and ${window(n)}${filters}${personFilter}
           group by 1)`);
        joins.push(`left join ${alias} on ${alias}.person = p.person`);
        const cnt = `coalesce(${alias}.n, 0)`;
        if (!n.did) return `(${cnt} = 0)`;
        const c = p.add(n.count);
        if (n.countOp === "gte") return `(${cnt} >= ${c}::int)`;
        if (n.countOp === "eq") return `(${cnt} = ${c}::int)`;
        return `(${cnt} >= 1 and ${cnt} <= ${c}::int)`;
      }
      case "revenue": {
        const alias = `c${ctes.length + 1}`;
        const key = p.add(n.property);
        const names = n.events.length ? ` and coalesce(e.canonical_name, e.event_name) = any(${p.add(n.events)}::text[])` : "";
        ctes.push(`${alias} as (
          select ${PERSON_EXPR} as person, sum(${numeric("e.properties", key)}) as total
            from platform.events e ${PERSON_JOIN}
           where e.environment_id = $1 and ${COUNTED_EVENTS} and coalesce(e.user_id, e.anonymous_id) is not null
             and ${window(n)}${names}${personFilter}
           group by 1)`);
        joins.push(`left join ${alias} on ${alias}.person = p.person`);
        return `(coalesce(${alias}.total, 0) ${CMP[n.op]} ${p.add(n.amount)}::numeric)`;
      }
      case "user_property":
        return propertyPredicate("p.props", n, p);
      case "first_seen":
      case "last_seen": {
        const col = n.type === "first_seen" ? "p.first_seen_at" : "p.last_seen_at";
        const since = `now() - make_interval(days => ${p.add(n.days)}::int)`;
        return n.op === "within_days" ? `coalesce(${col} >= ${since}, false)` : `coalesce(${col} < ${since}, false)`;
      }
      case "platform":
        return `coalesce(p.platforms && ${p.add(n.platforms)}::text[], false)`;
    }
  };

  const where = compileNode(def);
  const sql = `with ${peopleCtes(person)}${ctes.length ? ",\n    " + ctes.join(",\n    ") : ""}
    select p.person from people p
      ${joins.join("\n      ")}
     where ${where}
       and not exists (select 1 from platform.privacy_requests r
                        where r.environment_id = $1 and r.kind = 'deletion' and r.status in ('received', 'processing')
                          and (r.subject_user_id = p.person or 'anon:' || r.subject_anonymous_id = p.person))`;
  return { sql, params: p.values };
}

// ── Description (for lists and logs) ───────────────────────────────────────
const OP_TEXT: Record<string, string> = {
  eq: "is", neq: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains", not_contains: "does not contain",
  in: "is one of", exists: "is set", not_exists: "is not set",
};

function describeFilter(f: PropertyFilter): string {
  const v = Array.isArray(f.value) ? f.value.join(", ") : f.value === undefined ? "" : ` ${JSON.stringify(f.value)}`;
  return `${f.property} ${OP_TEXT[f.op]}${Array.isArray(f.value) ? ` ${v}` : v}`;
}

export function describeNode(n: AudienceNode): string {
  switch (n.type) {
    case "and":
    case "or":
      return n.children.length === 1 ? describeNode(n.children[0]) : `(${n.children.map(describeNode).join(n.type === "and" ? " AND " : " OR ")})`;
    case "not":
      return `NOT ${describeNode(n.child)}`;
    case "event": {
      const when = n.sinceTrigger ? "since the trigger" : n.between ? (n.between.from === n.between.to ? `on ${n.between.from}` : `between ${n.between.from} and ${n.between.to}`) : `in the last ${n.withinDays} days`;
      const where = n.where.length ? ` where ${n.where.map(describeFilter).join(" and ")}` : "";
      if (!n.did) return `did not do ${n.event}${where} ${when}`;
      const times = n.countOp === "gte" ? (n.count === 1 ? "" : ` at least ${n.count} times`) : n.countOp === "eq" ? ` exactly ${n.count} times` : ` at most ${n.count} times`;
      return `did ${n.event}${where}${times} ${when}`;
    }
    case "user_property":
      return `user ${describeFilter(n)}`;
    case "first_seen":
    case "last_seen":
      return `${n.type === "first_seen" ? "first" : "last"} seen ${n.op === "within_days" ? "in the last" : "more than"} ${n.days} days${n.op === "before_days" ? " ago" : ""}`;
    case "platform":
      return `uses ${n.platforms.join(" or ")}`;
    case "revenue":
      return `revenue ${OP_TEXT[n.op]} ${n.amount} in the last ${n.withinDays} days${n.events.length ? ` (${n.events.join(", ")})` : ""}`;
  }
}
