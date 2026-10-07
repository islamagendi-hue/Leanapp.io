import "server-only";
import type { Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { SYSTEM_EVENT_NAMES } from "@/modules/ingestion/schema";
import { recomputeImplementation } from "@/modules/processing/processor";
import { featureOn } from "@/modules/apps/features";
import { enqueueReprocess } from "@/modules/reprocess/jobs";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { generatePlan, type GeneratedPlan } from "./generator";
import { loadPlanEvents, type PlanEventRow } from "./plan-store";
import {
  QUESTION_BY_KEY, QUESTION_CATALOG_VERSION, coerceAnswers, nextQuestions, progress, SECTIONS,
  type Answers, type SectionKey,
} from "./questions";
import { computeScore, type ImplementationScore } from "./score";

const PROTOCOL_EVENTS = new Set(Object.values(SYSTEM_EVENT_NAMES).filter((n) => n !== "screen_viewed"));

export interface ProjectState {
  projectId: string;
  planId: string;
  status: string;
  progress: number;
  answers: Answers;
  publishedVersionId: string | null;
}

export async function projectFor(db: Db, appId: string): Promise<ProjectState> {
  const row = await db.one<{ id: string; status: string; progress: number; plan_id: string; published_version_id: string | null }>(
    `select p.id, p.status, p.progress, t.id as plan_id, t.published_version_id
       from platform.tracking_projects p join platform.tracking_plans t on t.tracking_project_id = p.id
      where p.app_id = $1`,
    [appId],
  );
  if (!row) throw new NotFoundError("Implementation project");
  const answers = Object.fromEntries(
    (await db.query<{ question_key: string; value: Answers[string] }>(
      "select question_key, value from platform.tracking_answers where tracking_project_id = $1",
      [row.id],
    )).map((a) => [a.question_key, a.value]),
  );
  return { projectId: row.id, planId: row.plan_id, status: row.status, progress: row.progress, answers, publishedVersionId: row.published_version_id };
}

export function getProject(ctx: TenantContext, appId: string) {
  return tenantTx(ctx, "implementation.read", (db) => projectFor(db, appId));
}

/** Saves one questionnaire section. Returns field errors instead of throwing so the form can show them. */
export async function saveAnswers(ctx: TenantContext, appId: string, section: SectionKey, raw: Record<string, unknown>) {
  if (!SECTIONS.some((s) => s.key === section)) throw new ValidationError("Unknown section.");
  return tenantTx(ctx, "implementation.edit", async (db) => {
    const project = await projectFor(db, appId);
    const { answers, errors } = coerceAnswers(section, raw, project.answers);
    if (Object.keys(errors).length) return { ok: false as const, errors };
    for (const [key, value] of Object.entries(answers)) {
      const q = QUESTION_BY_KEY[key];
      await db.query(
        `insert into platform.tracking_questions (organization_id, tracking_project_id, question_key, catalog_version, section, prompt)
         values ($1, $2, $3, $4, $5, $6) on conflict (tracking_project_id, question_key) do nothing`,
        [ctx.organizationId, project.projectId, key, QUESTION_CATALOG_VERSION, q.section, q.prompt],
      );
      await db.query(
        `insert into platform.tracking_answers (organization_id, tracking_project_id, question_key, value, answered_by)
         values ($1, $2, $3, $4, $5)
         on conflict (tracking_project_id, question_key) do update set value = excluded.value, answered_by = excluded.answered_by, answered_at = now()`,
        [ctx.organizationId, project.projectId, key, JSON.stringify(value), ctx.userId],
      );
    }
    const all = { ...project.answers, ...answers };
    const p = progress(all);
    await db.query("update platform.tracking_projects set progress = $2 where id = $1", [project.projectId, Math.round((p.answered / Math.max(p.total, 1)) * 40)]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "implementation.answers_saved", targetType: "app", targetId: appId, metadata: { section } });
    return { ok: true as const, next: nextQuestions(all) };
  });
}

// ── Plan versions ───────────────────────────────────────────────────────────
export interface PlanVersion {
  id: string;
  version: number;
  status: "draft" | "approved" | "published" | "archived";
  generator: string;
  business_model: string | null;
  activation_event: string | null;
  north_star_event: string | null;
  summary: Pick<GeneratedPlan, "classification" | "warnings" | "journey_matches" | "secondary_models" | "revenue_event">;
  created_at: Date;
  approved_at: Date | null;
  published_at: Date | null;
  /** The version a hand-edited draft was copied from. */
  based_on_version_id: string | null;
}

export const VERSION_COLUMNS = "id, version, status, generator, business_model, activation_event, north_star_event, summary, created_at, approved_at, published_at, based_on_version_id";

export function listVersions(ctx: TenantContext, appId: string): Promise<PlanVersion[]> {
  return tenantTx(ctx, "implementation.read", async (db) => {
    const project = await projectFor(db, appId);
    return db.query<PlanVersion>(`select ${VERSION_COLUMNS} from platform.tracking_plan_versions where tracking_plan_id = $1 order by version desc`, [project.planId]);
  });
}

export interface PlanDetail {
  version: PlanVersion;
  events: PlanEventRow[];
  userProperties: { name: string; type: string; description: string; source: string; reason: string }[];
  attributionRules: { channel: string; parameters: string[]; click_id_param: string | null; notes: string }[];
}

export function getPlanVersion(ctx: TenantContext, appId: string, versionId?: string): Promise<PlanDetail | null> {
  return tenantTx(ctx, "implementation.read", async (db) => {
    const project = await projectFor(db, appId);
    const version = await db.one<PlanVersion>(
      versionId
        ? `select ${VERSION_COLUMNS} from platform.tracking_plan_versions where tracking_plan_id = $1 and id = $2`
        : `select ${VERSION_COLUMNS} from platform.tracking_plan_versions where tracking_plan_id = $1 and status <> 'archived' order by version desc limit 1`,
      versionId ? [project.planId, versionId] : [project.planId],
    );
    if (!version) return null;
    return {
      version,
      events: await loadPlanEvents(db, version.id),
      userProperties: await db.query("select name, type, description, source, reason from platform.tracking_user_properties where plan_version_id = $1 order by name", [version.id]),
      attributionRules: await db.query("select channel, parameters, click_id_param, notes from platform.tracking_attribution_rules where plan_version_id = $1 order by channel", [version.id]),
    };
  });
}

/** Generates a new draft version from the current answers. Older drafts are archived. */
export async function generateDraft(ctx: TenantContext, appId: string): Promise<{ versionId: string; version: number }> {
  return tenantTx(ctx, "implementation.edit", async (db) => {
    const project = await projectFor(db, appId);
    if (!progress(project.answers).complete) throw new ValidationError("Finish the questionnaire first.");
    const platforms = (await db.query<{ platform: string }>("select platform from platform.app_platforms where app_id = $1", [appId])).map((r) => r.platform);
    const plan = generatePlan(project.answers, platforms);
    await db.query("update platform.tracking_plan_versions set status = 'archived', archived_at = now() where tracking_plan_id = $1 and status = 'draft'", [project.planId]);
    const next = await db.one<{ v: number }>("select coalesce(max(version), 0) + 1 as v from platform.tracking_plan_versions where tracking_plan_id = $1", [project.planId]);
    const version = await db.one<{ id: string }>(
      `insert into platform.tracking_plan_versions
         (organization_id, tracking_plan_id, version, status, generator, business_model, activation_event, north_star_event, summary, answers_snapshot, created_by)
       values ($1, $2, $3, 'draft', $4, $5, $6, $7, $8, $9, $10) returning id`,
      [ctx.organizationId, project.planId, next!.v, plan.generator, plan.business_model, plan.activation_event, plan.north_star_event,
       JSON.stringify({ classification: plan.classification, warnings: plan.warnings, journey_matches: plan.journey_matches, secondary_models: plan.secondary_models, revenue_event: plan.revenue_event }),
       JSON.stringify(project.answers), ctx.userId],
    );
    await insertPlanContents(db, ctx.organizationId, version!.id, plan);
    await db.query("update platform.tracking_projects set status = 'plan_draft', business_model = $2, progress = greatest(progress, 50) where id = $1", [project.projectId, plan.business_model]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "tracking_plan.generated", targetType: "tracking_plan_version", targetId: version!.id, metadata: { version: next!.v, events: plan.events.length } });
    return { versionId: version!.id, version: next!.v };
  });
}

async function insertPlanContents(db: Db, orgId: string, versionId: string, plan: GeneratedPlan) {
  let i = 0;
  for (const e of plan.events) {
    const row = await db.one<{ id: string }>(
      `insert into platform.tracking_events
         (organization_id, plan_version_id, event_name, display_name, description, category, "trigger", source, priority, required,
          activation_relevance, conversion_relevance, revenue_relevance, attribution_relevance, automation_relevance, platforms, reason, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
      [orgId, versionId, e.event_name, e.display_name, e.description, e.category, e.trigger, e.source, e.priority, e.required,
       e.activation_relevance, e.conversion_relevance, e.revenue_relevance, e.attribution_relevance, e.automation_relevance,
       e.platforms, e.source_note ? `${e.reason} ${e.source_note}` : e.reason, i++],
    );
    for (const p of e.properties) {
      await db.query(
        `insert into platform.tracking_event_properties (organization_id, tracking_event_id, name, type, required, description, example, allowed_values)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orgId, row!.id, p.name, p.type, p.required, p.description, p.example === undefined ? null : JSON.stringify(p.example), p.allowedValues ? JSON.stringify(p.allowedValues) : null],
      );
    }
  }
  for (const u of plan.user_properties) {
    await db.query(
      "insert into platform.tracking_user_properties (organization_id, plan_version_id, name, type, description, source, reason) values ($1, $2, $3, $4, $5, $6, $7)",
      [orgId, versionId, u.name, u.type, u.description, u.source, u.reason],
    );
  }
  for (const r of plan.attribution_rules) {
    await db.query(
      "insert into platform.tracking_attribution_rules (organization_id, plan_version_id, channel, parameters, click_id_param, notes) values ($1, $2, $3, $4, $5, $6)",
      [orgId, versionId, r.channel, r.parameters, r.click_id_param, r.notes],
    );
  }
}

async function versionInPlan(db: Db, appId: string, versionId: string) {
  const project = await projectFor(db, appId);
  const v = await db.one<{ id: string; status: string; version: number }>(
    "select id, status, version from platform.tracking_plan_versions where id = $1 and tracking_plan_id = $2 for update",
    [versionId, project.planId],
  );
  if (!v) throw new NotFoundError("Plan version");
  return { project, v };
}

/** Draft edits: drop an event or change whether it is required. Approved and published versions are immutable. */
export async function editDraftEvent(ctx: TenantContext, appId: string, versionId: string, eventName: string, change: { remove?: boolean; required?: boolean }) {
  return tenantTx(ctx, "implementation.edit", async (db) => {
    const { v } = await versionInPlan(db, appId, versionId);
    if (v.status !== "draft") throw new ConflictError("Only draft versions can be edited. Generate a new draft to change an approved plan.");
    if (change.remove) {
      const r = await db.query("delete from platform.tracking_events where plan_version_id = $1 and event_name = $2 returning id", [versionId, eventName]);
      if (!r.length) throw new NotFoundError("Event");
    } else if (typeof change.required === "boolean") {
      const r = await db.query("update platform.tracking_events set required = $3 where plan_version_id = $1 and event_name = $2 returning id", [versionId, eventName, change.required]);
      if (!r.length) throw new NotFoundError("Event");
    }
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "tracking_plan.edited", targetType: "tracking_plan_version", targetId: versionId, metadata: { event: eventName, ...change } });
  });
}

export async function approveVersion(ctx: TenantContext, appId: string, versionId: string) {
  return tenantTx(ctx, "implementation.approve", async (db) => {
    const { project, v } = await versionInPlan(db, appId, versionId);
    if (v.status !== "draft") throw new ConflictError(`Version ${v.version} is ${v.status}, not a draft.`);
    const count = await db.one<{ n: string }>("select count(*) as n from platform.tracking_events where plan_version_id = $1", [versionId]);
    if (Number(count?.n ?? 0) === 0) throw new ValidationError("A plan needs at least one event.");
    await db.query("update platform.tracking_plan_versions set status = 'approved', approved_by = $2, approved_at = now() where id = $1", [versionId, ctx.userId]);
    await db.query("update platform.tracking_projects set status = 'plan_approved', progress = greatest(progress, 60) where id = $1", [project.projectId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "tracking_plan.approved", targetType: "tracking_plan_version", targetId: versionId, metadata: { version: v.version } });
  });
}

/**
 * Publishing makes a version the one incoming events are validated against.
 * The previous published version is archived and implementation status is
 * recomputed from recent events. AI or rules never publish on their own:
 * this requires a person with implementation.approve.
 */
export async function publishVersion(ctx: TenantContext, appId: string, versionId: string) {
  return tenantTx(ctx, "implementation.approve", async (db) => {
    const { project, v } = await versionInPlan(db, appId, versionId);
    if (v.status !== "approved") throw new ConflictError("Approve this version before publishing it.");
    await db.query("update platform.tracking_plan_versions set status = 'archived', archived_at = now() where tracking_plan_id = $1 and status = 'published'", [project.planId]);
    await db.query("update platform.tracking_plan_versions set status = 'published', published_by = $2, published_at = now() where id = $1", [versionId, ctx.userId]);
    await db.query("update platform.tracking_plans set published_version_id = $2 where id = $1", [project.planId, versionId]);
    await db.query("update platform.tracking_projects set status = 'implementing', progress = greatest(progress, 70) where id = $1", [project.projectId]);
    await recomputeImplementation(db, appId);
    // Growth definitions are part of the published version: rebuild growth state from all events.
    if (await featureOn(db, appId, "growth_model")) await enqueueReprocess(db, appId, "growth_rebuild", `plan version ${v.version} published`, ctx.userId);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "tracking_plan.published", targetType: "tracking_plan_version", targetId: versionId, metadata: { version: v.version } });
  });
}

// ── Event mappings ──────────────────────────────────────────────────────────
export interface EventMapping {
  id: string;
  from_name: string;
  to_name: string;
  status: "suggested" | "accepted" | "rejected";
  similarity: number | null;
}

export function listMappings(ctx: TenantContext, appId: string): Promise<EventMapping[]> {
  return tenantTx(ctx, "implementation.read", (db) =>
    db.query<EventMapping>("select id, from_name, to_name, status, similarity from platform.event_mappings where app_id = $1 order by status, created_at desc", [appId]),
  );
}

export async function decideMapping(ctx: TenantContext, appId: string, mappingId: string, accept: boolean) {
  return tenantTx(ctx, "implementation.mapping", async (db) => {
    const row = await db.one<{ from_name: string; to_name: string }>(
      "update platform.event_mappings set status = $3, decided_by = $4, decided_at = now() where id = $1 and app_id = $2 returning from_name, to_name",
      [mappingId, appId, accept ? "accepted" : "rejected", ctx.userId],
    );
    if (!row) throw new NotFoundError("Mapping");
    if (accept) await recomputeImplementation(db, appId);
    await remapHistory(db, appId, `mapping ${row.from_name} → ${row.to_name} ${accept ? "accepted" : "rejected"}`, ctx.userId);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: accept ? "event_mapping.accepted" : "event_mapping.rejected", targetType: "event_mapping", targetId: mappingId, metadata: row });
  });
}

/** Creates or updates a mapping by hand (e.g. "purchase → purchase_completed"). */
export async function createMapping(ctx: TenantContext, appId: string, fromName: string, toName: string) {
  if (!/^[A-Za-z][A-Za-z0-9_ .:\-]{0,99}$/.test(fromName) || !/^[a-z][a-z0-9_]{1,63}$/.test(toName)) throw new ValidationError("Invalid event names.");
  return tenantTx(ctx, "implementation.mapping", async (db) => {
    await db.query(
      `insert into platform.event_mappings (organization_id, app_id, from_name, to_name, status, decided_by, decided_at)
       values ($1, $2, $3, $4, 'accepted', $5, now())
       on conflict (app_id, from_name) do update set to_name = excluded.to_name, status = 'accepted', decided_by = excluded.decided_by, decided_at = now()`,
      [ctx.organizationId, appId, fromName, toName, ctx.userId],
    );
    await recomputeImplementation(db, appId);
    await remapHistory(db, appId, `mapping ${fromName} → ${toName} set`, ctx.userId);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "event_mapping.accepted", targetType: "app", targetId: appId, metadata: { from: fromName, to: toName } });
  });
}

/**
 * With mapping history on, every mapping change also re-maps all past events
 * in the background (the instant pass above covers 30 days / 5,000 events).
 */
async function remapHistory(db: Db, appId: string, reason: string, userId: string) {
  if (await featureOn(db, appId, "mapping_history")) await enqueueReprocess(db, appId, "remap", reason, userId);
}

export interface MappingRevision {
  mapping_id: string;
  revision: number;
  from_name: string;
  to_name: string;
  status: EventMapping["status"];
  changed_by_email: string | null;
  changed_at: Date;
  reverted_to: number | null;
}

/** Every change to the app's mappings, newest first. */
export function listMappingHistory(ctx: TenantContext, appId: string, opts: { limit?: number } = {}): Promise<MappingRevision[]> {
  return tenantTx(ctx, "implementation.read", (db) => mappingHistory(db, appId, opts.limit ?? 200));
}

export function mappingHistory(db: Db, appId: string, limit: number): Promise<MappingRevision[]> {
  return db.query<MappingRevision>(
    `select h.mapping_id, h.revision, h.from_name, h.to_name, h.status, u.email as changed_by_email, h.changed_at, h.reverted_to
       from platform.event_mapping_history h left join platform.users u on u.id = h.changed_by
      where h.app_id = $1 order by h.changed_at desc, h.id desc limit $2`,
    [appId, Math.min(Math.max(limit, 1), 1000)],
  );
}

/**
 * Puts a mapping back to an earlier revision (target and status). Recorded as
 * a new revision that names the one it restored; earlier revisions are never
 * changed. Needs the mapping_history feature.
 */
export async function revertMapping(ctx: TenantContext, appId: string, mappingId: string, revision: number) {
  return tenantTx(ctx, "implementation.mapping", async (db) => {
    if (!(await featureOn(db, appId, "mapping_history"))) throw new ConflictError("Turn on mapping history for this app first.");
    const target = await db.one<{ to_name: string; status: EventMapping["status"]; from_name: string }>(
      "select to_name, status, from_name from platform.event_mapping_history where app_id = $1 and mapping_id = $2 and revision = $3",
      [appId, mappingId, revision],
    );
    if (!target) throw new NotFoundError("Mapping revision");
    const current = await db.one<{ to_name: string; status: string }>("select to_name, status from platform.event_mappings where id = $1 and app_id = $2 for update", [mappingId, appId]);
    if (!current) throw new NotFoundError("Mapping");
    if (current.to_name === target.to_name && current.status === target.status) throw new ConflictError("The mapping is already in that state.");
    await db.query("select set_config('platform.mapping_revert_to', $1, true)", [String(revision)]);
    await db.query("update platform.event_mappings set to_name = $3, status = $4, decided_by = $5, decided_at = now() where id = $1 and app_id = $2", [
      mappingId, appId, target.to_name, target.status, ctx.userId,
    ]);
    await db.query("select set_config('platform.mapping_revert_to', '', true)");
    await recomputeImplementation(db, appId);
    await remapHistory(db, appId, `mapping ${target.from_name} reverted to revision ${revision}`, ctx.userId);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "event_mapping.reverted", targetType: "event_mapping", targetId: mappingId, metadata: { revision, to: target.to_name, status: target.status } });
  });
}

// ── Validation & score ──────────────────────────────────────────────────────
export interface EventHealth {
  event_name: string;
  display_name: string;
  priority: PlanEventRow["priority"];
  source: PlanEventRow["source"];
  required: boolean;
  status: string;
  received_count: number;
  valid_count: number;
  invalid_count: number;
  last_received_at: Date | null;
  sources: string[];
}

export interface ImplementationReport {
  published: boolean;
  versionNumber: number | null;
  score: ImplementationScore | null;
  events: EventHealth[];
  unplanned: { event_name: string; received_count: number; last_received_at: Date }[];
  recentErrors: { event_name: string; errors: unknown; created_at: Date }[];
  lastEventAt: Date | null;
}

export function implementationReport(ctx: TenantContext, appId: string, environmentId: string): Promise<ImplementationReport> {
  return tenantTx(ctx, "implementation.read", async (db) => {
    const project = await projectFor(db, appId);
    const statuses = await db.query<{ event_name: string; status: string; received_count: string; valid_count: string; invalid_count: string; last_received_at: Date; last_sources: string[] }>(
      "select event_name, status, received_count, valid_count, invalid_count, last_received_at, last_sources from platform.tracking_implementation_status where environment_id = $1",
      [environmentId],
    );
    const byName = new Map(statuses.map((s) => [s.event_name, s]));
    const last = await db.one<{ at: Date | null }>("select max(received_at) as at from platform.events where environment_id = $1", [environmentId]);
    const recentErrors = await db.query<{ event_name: string; errors: unknown; created_at: Date }>(
      "select event_name, errors, created_at from platform.tracking_validation_results where environment_id = $1 order by created_at desc limit 20",
      [environmentId],
    );
    if (!project.publishedVersionId) {
      return {
        published: false, versionNumber: null, score: null, events: [], recentErrors, lastEventAt: last?.at ?? null,
        unplanned: statuses.filter((s) => !PROTOCOL_EVENTS.has(s.event_name)).map((s) => ({ event_name: s.event_name, received_count: Number(s.received_count), last_received_at: s.last_received_at })),
      };
    }
    const version = await db.one<{ version: number }>("select version from platform.tracking_plan_versions where id = $1", [project.publishedVersionId]);
    const events = await loadPlanEvents(db, project.publishedVersionId);
    const planned = new Set(events.map((e) => e.event_name));
    const userProps = (await db.query<{ name: string }>("select name from platform.tracking_user_properties where plan_version_id = $1", [project.publishedVersionId])).map((r) => r.name);
    const attrParams = [...new Set((await db.query<{ parameters: string[] }>("select parameters from platform.tracking_attribution_rules where plan_version_id = $1", [project.publishedVersionId])).flatMap((r) => r.parameters))];
    const observedUserProps = (await db.query<{ k: string }>(
      `select distinct k from (select jsonb_object_keys(properties) as k from platform.app_users where environment_id = $1
                               order by last_seen_at desc limit 5000) x`,
      [environmentId],
    )).map((r) => r.k);
    const observedAttr = (await db.query<{ k: string }>(
      `select distinct regexp_replace(k, '^utm_', '') as k from (
         select jsonb_object_keys(context->'attribution') as k from platform.events
          where environment_id = $1 and jsonb_typeof(context->'attribution') = 'object' and received_at > now() - interval '30 days'
          order by id desc limit 5000) x`,
      [environmentId],
    )).map((r) => (["gclid", "fbclid", "ttclid", "sccid", "twclid", "click_id"].includes(r.k.toLowerCase()) ? "click_id" : r.k));
    // Automatic context the SDK always attaches counts as present.
    observedUserProps.push(...(last?.at ? ["platform", "app_version", "language", "country"] : []));
    const score = computeScore({
      events: events.map((e) => {
        const s = byName.get(e.event_name);
        return {
          event_name: e.event_name, source: e.source, priority: e.priority, required: e.required,
          revenue_relevance: e.revenue_relevance, automation_relevance: e.automation_relevance,
          status: s ? { received: Number(s.received_count), valid: Number(s.valid_count), invalid: Number(s.invalid_count), sources: s.last_sources } : null,
        };
      }),
      plannedUserProperties: userProps,
      observedUserProperties: observedUserProps,
      plannedAttributionParameters: attrParams.filter((p) => p !== "touchpoint_timestamp"),
      observedAttributionParameters: observedAttr,
      lastEventAt: last?.at ?? null,
      now: new Date(),
    });
    return {
      published: true,
      versionNumber: version?.version ?? null,
      score,
      lastEventAt: last?.at ?? null,
      recentErrors,
      events: events.map((e) => {
        const s = byName.get(e.event_name);
        return {
          event_name: e.event_name, display_name: e.display_name, priority: e.priority, source: e.source, required: e.required,
          status: s?.status ?? "approved", received_count: Number(s?.received_count ?? 0), valid_count: Number(s?.valid_count ?? 0),
          invalid_count: Number(s?.invalid_count ?? 0), last_received_at: s?.last_received_at ?? null, sources: s?.last_sources ?? [],
        };
      }),
      // identify / alias / push-token calls are SDK protocol events, not product events a plan should list.
      unplanned: statuses.filter((s) => !planned.has(s.event_name) && !PROTOCOL_EVENTS.has(s.event_name)).map((s) => ({ event_name: s.event_name, received_count: Number(s.received_count), last_received_at: s.last_received_at })),
    };
  });
}
