import { msg } from "@/i18n/translate";
import "server-only";
import { withTenant, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import type { Permission } from "@/modules/rbac/permissions";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { EVENT_LIBRARY } from "./catalog/events";
import { PROPERTY_SETS } from "./catalog/properties";
import { diffPlans, planToCsv, planToJson, type PlanDiff, type PlanSnapshot } from "./diff";
import { definitionProblems, growthDefinitionSchema, type GrowthDefinition } from "@/modules/growth/definition";
import { loadPlanEvents } from "./plan-store";
import {
  checkEventName, checkProperties, checkPropertyName, displayName, eventPropertyInput, eventUpdateInput, newEventInput, parseInput,
  userPropertyInput, type EventPropertyInput,
} from "./plan-input";
import { projectFor, VERSION_COLUMNS, type PlanVersion } from "./service";

/**
 * Hand edits to the tracking plan: custom events and their properties, user
 * properties, diffs between versions and exports.
 *
 * Approved and published versions are immutable. Every edit lands on the
 * plan's working draft; when there is none, the newest approved or published
 * version is copied into a new draft version and the edit applies to the copy.
 * The draft then goes through the existing approve → publish flow, and
 * publishing recomputes implementation status as before.
 */

/** Who is editing: a dashboard member, or a secret key with `plan:write` for its own app. */
export type PlanActor =
  | { kind: "user"; ctx: TenantContext }
  | { kind: "api_key"; organizationId: string; appId: string; keyId: string };

interface Who {
  organizationId: string;
  userId: string | null;
  actorType: "user" | "api_key";
  keyId?: string;
}

function run<T>(actor: PlanActor, permission: Permission, appId: string, fn: (db: Db, who: Who) => Promise<T>): Promise<T> {
  if (actor.kind === "user") {
    return tenantTx(actor.ctx, permission, (db) => fn(db, { organizationId: actor.ctx.organizationId, userId: actor.ctx.userId, actorType: "user" }));
  }
  // A key only ever reaches its own app.
  if (actor.appId !== appId) throw new NotFoundError("App");
  return withTenant({ organizationId: actor.organizationId, userId: null }, (db) =>
    fn(db, { organizationId: actor.organizationId, userId: null, actorType: "api_key", keyId: actor.keyId }),
  );
}

function logEdit(db: Db, who: Who, action: "tracking_plan.edited" | "tracking_plan.draft_created", versionId: string, metadata: Record<string, unknown>) {
  return audit(db, {
    organizationId: who.organizationId, actorUserId: who.userId, actorType: who.actorType, action,
    targetType: "tracking_plan_version", targetId: versionId, metadata: who.keyId ? { ...metadata, api_key_id: who.keyId } : metadata,
  });
}

export interface DraftRef {
  versionId: string;
  version: number;
  /** True when this edit copied an approved / published version into a new draft. */
  draftCreated: boolean;
}

/** The plan's working draft, creating it from the latest version when there is none. Locks the plan for the transaction. */
async function workingDraft(db: Db, who: Who, appId: string): Promise<DraftRef> {
  const project = await projectFor(db, appId);
  await db.query("select id from platform.tracking_plans where id = $1 for update", [project.planId]);
  const draft = await db.one<{ id: string; version: number }>(
    "select id, version from platform.tracking_plan_versions where tracking_plan_id = $1 and status = 'draft' order by version desc limit 1",
    [project.planId],
  );
  if (draft) return { versionId: draft.id, version: draft.version, draftCreated: false };

  // The newest live version: an approved one waiting to be published, else the published one (else the newest archived).
  const base = await db.one<{ id: string; version: number }>(
    `select id, version from platform.tracking_plan_versions where tracking_plan_id = $1
      order by (status <> 'archived') desc, version desc limit 1`,
    [project.planId],
  );
  const next = await db.one<{ v: number }>("select coalesce(max(version), 0) + 1 as v from platform.tracking_plan_versions where tracking_plan_id = $1", [project.planId]);
  let id: string;
  if (base) {
    id = (await db.one<{ id: string }>(
      `insert into platform.tracking_plan_versions
         (organization_id, tracking_plan_id, version, status, generator, business_model, activation_event, north_star_event, summary, answers_snapshot, growth, created_by, based_on_version_id)
       select organization_id, tracking_plan_id, $2, 'draft', generator, business_model, activation_event, north_star_event, summary, answers_snapshot, growth, $3, id
         from platform.tracking_plan_versions where id = $1
       returning id`,
      [base.id, next!.v, who.userId],
    ))!.id;
    await db.query(
      `with src as (select * from platform.tracking_events where plan_version_id = $1),
            ins as (
              insert into platform.tracking_events
                (organization_id, plan_version_id, event_name, display_name, description, category, "trigger", source, priority, required, custom,
                 activation_relevance, conversion_relevance, revenue_relevance, attribution_relevance, automation_relevance, platforms, reason, schema_version, sort_order)
              select organization_id, $2, event_name, display_name, description, category, "trigger", source, priority, required, custom,
                     activation_relevance, conversion_relevance, revenue_relevance, attribution_relevance, automation_relevance, platforms, reason, schema_version, sort_order
                from src
              returning id, event_name)
       insert into platform.tracking_event_properties (organization_id, tracking_event_id, name, type, required, description, example, allowed_values)
       select p.organization_id, ins.id, p.name, p.type, p.required, p.description, p.example, p.allowed_values
         from ins join src on src.event_name = ins.event_name
         join platform.tracking_event_properties p on p.tracking_event_id = src.id`,
      [base.id, id],
    );
    await db.query(
      `insert into platform.tracking_user_properties (organization_id, plan_version_id, name, type, description, source, reason)
       select organization_id, $2, name, type, description, source, reason from platform.tracking_user_properties where plan_version_id = $1`,
      [base.id, id],
    );
    await db.query(
      `insert into platform.tracking_attribution_rules (organization_id, plan_version_id, channel, parameters, click_id_param, notes)
       select organization_id, $2, channel, parameters, click_id_param, notes from platform.tracking_attribution_rules where plan_version_id = $1`,
      [base.id, id],
    );
  } else {
    // No plan yet (questionnaire skipped): start an empty hand-written one.
    id = (await db.one<{ id: string }>(
      `insert into platform.tracking_plan_versions (organization_id, tracking_plan_id, version, status, generator, summary, created_by)
       values ($1, $2, $3, 'draft', 'manual', $4, $5) returning id`,
      [who.organizationId, project.planId, next!.v, JSON.stringify({ warnings: [], journey_matches: [], secondary_models: [], revenue_event: null }), who.userId],
    ))!.id;
  }
  await db.query("update platform.tracking_projects set status = 'plan_draft', progress = greatest(progress, 50) where id = $1 and status = 'questionnaire'", [project.projectId]);
  await logEdit(db, who, "tracking_plan.draft_created", id, { version: next!.v, based_on_version: base?.version ?? null });
  return { versionId: id, version: next!.v, draftCreated: true };
}

async function eventIn(db: Db, versionId: string, eventName: string) {
  const row = await db.one<{ id: string }>("select id from platform.tracking_events where plan_version_id = $1 and event_name = $2", [versionId, eventName]);
  if (!row) throw new NotFoundError(`Event ${eventName}`);
  return row.id;
}

async function insertProperty(db: Db, orgId: string, eventId: string, p: EventPropertyInput) {
  await db.query(
    `insert into platform.tracking_event_properties (organization_id, tracking_event_id, name, type, required, description, example, allowed_values)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tracking_event_id, name) do update
       set type = excluded.type, required = excluded.required, description = excluded.description, example = excluded.example, allowed_values = excluded.allowed_values`,
    [orgId, eventId, p.name, p.type, p.required, p.description, p.example === undefined || p.example === null ? null : JSON.stringify(p.example),
     p.allowed_values?.length ? JSON.stringify(p.allowed_values) : null],
  );
}

const MOBILE = new Set(["android", "ios", "react_native", "flutter", "web"]);

async function defaultPlatforms(db: Db, appId: string, source: string): Promise<string[]> {
  const app = (await db.query<{ platform: string }>("select platform from platform.app_platforms where app_id = $1", [appId])).map((r) => r.platform);
  const mobile = app.filter((p) => MOBILE.has(p));
  if (source === "backend") return ["backend"];
  if (source === "both") return [...mobile, "backend"];
  return mobile.length ? mobile : ["android", "ios"];
}

export interface EditResult extends DraftRef {
  warnings: string[];
}

/**
 * Adds an event to the draft. A standard library name (e.g. `refund_completed`)
 * starts from the library's definition and properties; anything given overrides it.
 */
export async function addPlanEvent(actor: PlanActor, appId: string, input: unknown): Promise<EditResult> {
  const e = parseInput(newEventInput, input);
  const { warnings } = checkEventName(e.event_name);
  const lib = EVENT_LIBRARY[e.event_name];
  const properties: EventPropertyInput[] =
    e.properties ?? (lib?.properties ? PROPERTY_SETS[lib.properties].map((p) => ({ name: p.name, type: p.type, required: p.required, description: p.description, allowed_values: p.allowedValues ?? null, example: (p.example ?? null) as EventPropertyInput["example"] })) : []);
  checkProperties(properties);
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    if (await db.one("select 1 from platform.tracking_events where plan_version_id = $1 and event_name = $2", [draft.versionId, e.event_name])) {
      throw new ConflictError(`${e.event_name} is already in the plan. Edit it instead.`);
    }
    const source = e.source ?? lib?.source ?? "mobile_sdk";
    const order = await db.one<{ n: number }>("select coalesce(max(sort_order), -1) + 1 as n from platform.tracking_events where plan_version_id = $1", [draft.versionId]);
    const row = await db.one<{ id: string }>(
      `insert into platform.tracking_events
         (organization_id, plan_version_id, event_name, display_name, description, category, "trigger", source, priority, required, custom,
          activation_relevance, conversion_relevance, revenue_relevance, attribution_relevance, automation_relevance, platforms, reason, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, false, $11, $12, $13, $14, $15, $16, $17) returning id`,
      [who.organizationId, draft.versionId, e.event_name,
       e.display_name || lib?.display || displayName(e.event_name),
       e.description ?? lib?.description ?? "",
       e.category || lib?.category || "custom",
       e.trigger ?? lib?.trigger ?? "",
       source,
       e.priority ?? lib?.priority ?? "medium",
       e.required ?? false,
       e.conversion_relevance ?? !!lib?.conversion,
       e.revenue_relevance ?? !!lib?.revenue,
       e.attribution_relevance ?? !!lib?.attribution,
       e.automation_relevance ?? !!lib?.automation,
       e.platforms ?? (await defaultPlatforms(db, appId, source)),
       e.reason || (lib ? `Added by hand from the standard library. ${lib.reason}` : msg("Added by hand.")),
       order!.n],
    );
    for (const p of properties) await insertProperty(db, who.organizationId, row!.id, p);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "event_added", event: e.event_name, properties: properties.length });
    return { ...draft, warnings };
  });
}

/** Changes an event's fields (not its name or properties) in the draft. */
export async function updatePlanEvent(actor: PlanActor, appId: string, eventName: string, input: unknown): Promise<EditResult> {
  const u = parseInput(eventUpdateInput, input);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(u)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k === "trigger" ? '"trigger"' : k} = $${values.length + 2}`);
  }
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const r = await db.query(`update platform.tracking_events set ${sets.join(", ")} where plan_version_id = $1 and event_name = $2 returning id`, [draft.versionId, eventName, ...values]);
    if (!r.length) throw new NotFoundError(`Event ${eventName}`);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "event_updated", event: eventName, fields: Object.keys(u).filter((k) => u[k as keyof typeof u] !== undefined) });
    return { ...draft, warnings: [] };
  });
}

export async function removePlanEvent(actor: PlanActor, appId: string, eventName: string): Promise<EditResult> {
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const r = await db.query("delete from platform.tracking_events where plan_version_id = $1 and event_name = $2 returning id", [draft.versionId, eventName]);
    if (!r.length) throw new NotFoundError(`Event ${eventName}`);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "event_removed", event: eventName });
    return { ...draft, warnings: [] };
  });
}

/** Adds or replaces one property of an event in the draft. */
export async function setPlanEventProperty(actor: PlanActor, appId: string, eventName: string, input: unknown): Promise<EditResult> {
  const p = parseInput(eventPropertyInput, input);
  checkProperties([p]);
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const eventId = await eventIn(db, draft.versionId, eventName);
    await insertProperty(db, who.organizationId, eventId, p);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "property_set", event: eventName, property: p.name });
    return { ...draft, warnings: [] };
  });
}

export async function removePlanEventProperty(actor: PlanActor, appId: string, eventName: string, propertyName: string): Promise<EditResult> {
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const eventId = await eventIn(db, draft.versionId, eventName);
    const r = await db.query("delete from platform.tracking_event_properties where tracking_event_id = $1 and name = $2 returning id", [eventId, propertyName]);
    if (!r.length) throw new NotFoundError(`Property ${propertyName}`);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "property_removed", event: eventName, property: propertyName });
    return { ...draft, warnings: [] };
  });
}

/** Adds or replaces a user property in the draft. */
export async function setPlanUserProperty(actor: PlanActor, appId: string, input: unknown): Promise<EditResult> {
  const u = parseInput(userPropertyInput, input);
  checkPropertyName(u.name, "user");
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    await db.query(
      `insert into platform.tracking_user_properties (organization_id, plan_version_id, name, type, description, source, reason)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (plan_version_id, name) do update set type = excluded.type, description = excluded.description, source = excluded.source, reason = excluded.reason`,
      [who.organizationId, draft.versionId, u.name, u.type, u.description, u.source, u.reason],
    );
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "user_property_set", property: u.name });
    return { ...draft, warnings: [] };
  });
}

export async function removePlanUserProperty(actor: PlanActor, appId: string, name: string): Promise<EditResult> {
  return run(actor, "implementation.edit", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const r = await db.query("delete from platform.tracking_user_properties where plan_version_id = $1 and name = $2 returning id", [draft.versionId, name]);
    if (!r.length) throw new NotFoundError(`User property ${name}`);
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "user_property_removed", property: name });
    return { ...draft, warnings: [] };
  });
}

// ── Snapshots, diff, export ─────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saves growth definitions into the working draft (copying the live version
 * into a new draft when there is none). They take effect when the draft is
 * approved and published, like every other plan change. The plan's
 * activation and north-star events follow the activation and core action.
 */
export async function setDraftGrowth(actor: PlanActor, appId: string, input: unknown): Promise<DraftRef & { definition: GrowthDefinition }> {
  const parsed = growthDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join(" "));
  const def = parsed.data;
  return run(actor, "growth.write", appId, async (db, who) => {
    const draft = await workingDraft(db, who, appId);
    const events = (await db.query<{ event_name: string }>("select event_name from platform.tracking_events where plan_version_id = $1", [draft.versionId])).map((r) => r.event_name);
    const problems = definitionProblems(def, events);
    if (problems.length) throw new ValidationError(problems.join(" "));
    await db.query(
      `update platform.tracking_plan_versions set growth = $2,
              activation_event = coalesce($3, activation_event), north_star_event = coalesce($4, north_star_event)
        where id = $1`,
      [draft.versionId, JSON.stringify(def), def.activation?.event ?? null, def.core_action?.event ?? null],
    );
    await logEdit(db, who, "tracking_plan.edited", draft.versionId, { op: "growth_definitions_saved" });
    return { ...draft, definition: def };
  });
}

async function snapshot(db: Db, planId: string, versionId: string): Promise<PlanSnapshot> {
  if (!UUID.test(versionId)) throw new NotFoundError("Plan version");
  const version = await db.one<PlanVersion & { growth: unknown }>(`select ${VERSION_COLUMNS}, growth from platform.tracking_plan_versions where id = $1 and tracking_plan_id = $2`, [versionId, planId]);
  if (!version) throw new NotFoundError("Plan version");
  const events = await loadPlanEvents(db, versionId);
  return {
    version,
    events: events.map(({ id: _id, sort_order: _s, ...e }) => e),
    user_properties: await db.query("select name, type, description, source, reason from platform.tracking_user_properties where plan_version_id = $1 order by name", [versionId]),
    attribution_rules: await db.query("select channel, parameters, click_id_param, notes from platform.tracking_attribution_rules where plan_version_id = $1 order by channel", [versionId]),
  };
}

/** What changed from version `fromId` to version `toId` (any two versions of the app's plan, either order). */
export function diffPlanVersions(ctx: TenantContext, appId: string, fromId: string, toId: string): Promise<PlanDiff> {
  return tenantTx(ctx, "implementation.read", async (db) => {
    const project = await projectFor(db, appId);
    return diffPlans(await snapshot(db, project.planId, fromId), await snapshot(db, project.planId, toId));
  });
}

/** A version of the plan, or the published one when `versionId` is "published". Null when nothing is published yet. */
export function readPlan(actor: PlanActor, appId: string, versionId: string | "published"): Promise<PlanSnapshot | null> {
  return run(actor, "implementation.read", appId, async (db) => {
    const project = await projectFor(db, appId);
    const id = versionId === "published" ? project.publishedVersionId : versionId;
    return id ? snapshot(db, project.planId, id) : null;
  });
}

export type ExportFormat = "json" | "csv";

/** The plan as a downloadable file. */
export async function exportPlan(ctx: TenantContext, appId: string, versionId: string, format: ExportFormat) {
  const s = await readPlan({ kind: "user", ctx }, appId, versionId);
  if (!s) throw new NotFoundError("Plan version");
  const app = await tenantTx(ctx, "implementation.read", (db) => db.one<{ id: string; name: string; slug: string }>("select id, name, slug from platform.apps where id = $1", [appId]));
  if (!app) throw new NotFoundError("App");
  const filename = `${app.slug}-tracking-plan-v${s.version.version}.${format}`;
  return format === "csv"
    ? { filename, contentType: "text/csv; charset=utf-8", body: planToCsv(s) }
    : { filename, contentType: "application/json; charset=utf-8", body: JSON.stringify(planToJson(s, app), null, 2) + "\n" };
}
