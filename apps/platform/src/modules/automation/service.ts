import "server-only";
import { z } from "zod";
import { msg, type T } from "@/i18n/translate";
import type { Db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { COUNTED_EVENTS, PERSON } from "@/modules/analytics/sql";
import { DefinitionError, parseDefinition } from "@/modules/audiences/definition";
import { can } from "@/modules/rbac/authorize";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { checkMessagingStep } from "@/modules/messaging/step-checks";
import { AutomationDefinitionError, parseAutomation, referencedAudiences, referencedEmailTemplates, referencedWebhooks, type AutomationDefinition } from "./definition";
import { FLOW_TEMPLATE_IDS, getFlowTemplate, needsWhatsApp, planFlowTemplate } from "./library";
import { fill } from "./messages";
import { nextScheduled } from "./time";
import { syncAutomationMedia } from "@/modules/media/service";

/**
 * Automations: CRUD, versioning and lifecycle. Every save of the definition is
 * a new version (automation_versions); runs keep executing the version they
 * started on, so editing a live automation never changes a run mid-way.
 * Execution lives in ./engine.ts.
 */
export interface AutomationRow {
  id: string;
  environment_id: string;
  name: string;
  /** "campaign": a one-message send to an audience (Engage → Campaigns); "automation": a flow. */
  kind: "automation" | "campaign";
  status: "draft" | "active" | "paused" | "archived";
  definition: AutomationDefinition;
  version: number;
  activated_at: Date | null;
  next_fire_at: Date | null;
  created_at: Date;
  updated_at: Date;
  runs: { active: number; completed: number; failed: number; total: number };
}

export interface RunRow {
  id: string;
  user_key: string;
  status: "pending" | "waiting" | "running" | "completed" | "failed" | "cancelled";
  current_step: number;
  version: number;
  next_run_at: Date | null;
  started_at: Date;
  finished_at: Date | null;
  trigger_key: string | null;
  trigger_data: Record<string, unknown>;
  last_error: string | null;
  log: RunLogEntry[];
}

export interface RunLogEntry {
  at: string;
  step: number | null;
  type: string;
  outcome: "started" | "done" | "skipped" | "failed" | "waiting" | "exit" | "completed" | "cancelled";
  detail?: string;
}

const nameSchema = z.string().trim().min(2, msg("Name the automation.")).max(80);

function parseDef(input: unknown): AutomationDefinition {
  try {
    return parseAutomation(typeof input === "string" ? JSON.parse(input) : input);
  } catch (err) {
    throw new ValidationError(err instanceof AutomationDefinitionError ? err.message : msg("The automation is not valid."));
  }
}

function parseAudienceDefinition(input: unknown) {
  try {
    return parseDefinition(input);
  } catch (err) {
    throw new ValidationError(err instanceof DefinitionError ? err.message : msg("The audience definition is not valid."));
  }
}

function parseName(v: unknown): string {
  const r = nameSchema.safeParse(v);
  if (!r.success) throw new ValidationError(r.error.issues[0].message);
  return r.data;
}

const SELECT = `
  select a.id, a.environment_id, a.name, a.kind, a.status, a.definition, a.version, a.activated_at, a.next_fire_at, a.created_at, a.updated_at,
         json_build_object(
           'active', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status in ('pending', 'waiting', 'running')),
           'completed', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status = 'completed'),
           'failed', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status = 'failed'),
           'total', (select count(*) from platform.automation_runs r where r.automation_id = a.id)) as runs
    from platform.automations a`;

export function listAutomations(ctx: TenantContext, environmentId: string, kind: AutomationRow["kind"] = "automation"): Promise<AutomationRow[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query<AutomationRow>(`${SELECT} where a.environment_id = $1 and a.kind = $2 order by a.status = 'archived', a.name`, [environmentId, kind]),
  );
}

const uuid = z.string().uuid();

export async function getAutomation(ctx: TenantContext, id: string, opts: { runStatus?: string; limit?: number } = {}): Promise<{
  automation: AutomationRow;
  versions: { version: number; created_at: Date; created_by_name: string | null }[];
  runs: RunRow[];
}> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Automation");
  return tenantTx(ctx, "automations.read", async (db) => {
    const automation = await db.one<AutomationRow>(`${SELECT} where a.id = $1`, [id]);
    if (!automation) throw new NotFoundError("Automation");
    const versions = await db.query<{ version: number; created_at: Date; created_by_name: string | null }>(
      `select v.version, v.created_at, u.name as created_by_name from platform.automation_versions v
         left join platform.users u on u.id = v.created_by where v.automation_id = $1 order by v.version desc limit 20`,
      [id],
    );
    const statuses = ["pending", "waiting", "running", "completed", "failed", "cancelled"];
    const runs = await db.query<RunRow>(
      `select id, user_key, status, current_step, version, next_run_at, started_at, finished_at, trigger_key, trigger_data, last_error, log
         from platform.automation_runs where automation_id = $1 and ($2::text is null or status = $2)
        order by started_at desc limit $3`,
      [id, statuses.includes(opts.runStatus ?? "") ? opts.runStatus : null, Math.min(opts.limit ?? 50, 200)],
    );
    return { automation, versions, runs };
  });
}

/** Checks that referenced audiences and webhooks exist in the automation's environment. */
async function checkReferences(db: Db, environmentId: string, d: AutomationDefinition, opts: { requireActive: boolean }) {
  for (const id of referencedAudiences(d)) {
    const a = await db.one<{ status: string; name: string }>("select status, name from platform.audiences where id = $1 and environment_id = $2", [id, environmentId]);
    if (!a || a.status === "archived") throw new ValidationError(msg("The trigger's audience doesn't exist in this environment."));
    if (opts.requireActive && a.status !== "active") throw new ValidationError(fill(msg('Activate the audience "{name}" first.'), { name: a.name }));
  }
  for (const id of referencedWebhooks(d)) {
    const w = await db.one("select id from platform.webhooks where id = $1 and environment_id = $2", [id, environmentId]);
    if (!w) throw new ValidationError(msg("A webhook step points to a webhook that doesn't exist in this environment."));
  }
  for (const id of referencedEmailTemplates(d)) {
    const t = await db.one("select id from platform.email_templates where id = $1 and environment_id = $2", [id, environmentId]);
    if (!t) throw new ValidationError(msg("An email step points to a template that doesn't exist in this environment."));
  }
  const env = await db.one<{ app_id: string; organization_id: string }>("select app_id, organization_id from platform.environments where id = $1", [environmentId]);
  for (const s of d.steps) {
    if (s.type !== "whatsapp" && s.type !== "whatsapp_session" && s.type !== "sms") continue;
    const issues = await checkMessagingStep(db, { organizationId: env!.organization_id, appId: env!.app_id, environmentId }, s, opts);
    const first = issues.find((i) => i.level === "error");
    if (first) throw new ValidationError(first.message);
  }
}

export async function createAutomation(
  ctx: TenantContext,
  environmentId: string,
  input: { name?: unknown; definition?: unknown },
  opts: { kind?: AutomationRow["kind"]; template?: string } = {},
): Promise<{ id: string }> {
  const name = parseName(input.name);
  const definition = parseDef(input.definition);
  return tenantTx(ctx, "automations.manage", (db) => insertAutomation(db, ctx, environmentId, name, definition, opts));
}

async function insertAutomation(
  db: Db,
  ctx: TenantContext,
  environmentId: string,
  name: string,
  definition: AutomationDefinition,
  opts: { kind?: AutomationRow["kind"]; template?: string; audienceId?: string },
): Promise<{ id: string }> {
  const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
  if (!env) throw new NotFoundError("Environment");
  await checkReferences(db, environmentId, definition, { requireActive: false });
  const row = await db.one<{ id: string }>(
    `insert into platform.automations (organization_id, app_id, environment_id, name, definition, version, created_by, updated_by, kind)
     values ($1, $2, $3, $4, $5, 1, $6, $6, $7) returning id`,
    [ctx.organizationId, env.app_id, environmentId, name, JSON.stringify(definition), ctx.userId, opts.kind ?? "automation"],
  );
  await db.query(
    "insert into platform.automation_versions (organization_id, automation_id, version, definition, created_by) values ($1, $2, 1, $3, $4)",
    [ctx.organizationId, row!.id, JSON.stringify(definition), ctx.userId],
  );
  await syncAutomationMedia(db, ctx, row!.id, definition);
  const metadata = { environment_id: environmentId, name, kind: opts.kind ?? "automation", ...(opts.template ? { template: opts.template } : {}), ...(opts.audienceId ? { audience_id: opts.audienceId } : {}) };
  await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.created", targetType: "automation", targetId: row!.id, metadata });
  return { id: row!.id };
}

const whatsappChoice = z.object({
  template: z.string().trim().min(1).max(512),
  language: z.string().trim().min(2).max(10),
  bodyParams: z.array(z.string().trim().min(1).max(1024)).max(20).default([]),
});

/**
 * A flow from the library (./library.ts), with `events` mapping the
 * template's event slots to this app's event names (suggestions otherwise).
 * Always created as a draft: nothing is sent until someone activates it.
 * Events the app doesn't send yet are allowed; the flow just won't start
 * until they arrive. A template that starts from an audience creates that
 * audience too, as a draft, in the same transaction (it needs
 * audiences.manage); activating the flow asks for the audience to be
 * activated first. A WhatsApp template needs an approved, synced template.
 */
export async function createAutomationFromTemplate(
  ctx: TenantContext,
  environmentId: string,
  templateId: unknown,
  input: { events?: Record<string, unknown>; whatsapp?: unknown } = {},
  opts: { t?: T } = {},
): Promise<{ id: string; audienceId: string | null }> {
  const id = z.enum(FLOW_TEMPLATE_IDS).safeParse(templateId);
  if (!id.success) throw new ValidationError(msg("Choose a flow from the library."));
  const template = getFlowTemplate(id.data);
  let whatsapp: z.infer<typeof whatsappChoice> | null = null;
  if (needsWhatsApp(template)) {
    const w = whatsappChoice.safeParse(input.whatsapp);
    if (!w.success) throw new ValidationError(msg("Choose an approved WhatsApp template for this flow."));
    whatsapp = w.data;
  }
  const plan = planFlowTemplate(id.data, input.events ?? {}, opts.t, null, { whatsapp: whatsapp && { ...whatsapp, headerParams: [] } });
  const name = parseName(plan.name);
  // Checked with the placeholder audience; the real id replaces it below.
  parseDef(plan.definition);
  const audience = plan.audience && { ...plan.audience, definition: parseAudienceDefinition(plan.audience.definition) };
  if (audience && !can(ctx.role, "audiences.manage")) throw new ForbiddenError(msg("This flow creates an audience, which your role can't do."));
  return tenantTx(ctx, "automations.manage", async (db) => {
    let audienceId: string | null = null;
    let definition = plan.definition;
    if (audience) {
      const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
      if (!env) throw new NotFoundError("Environment");
      const row = await db.one<{ id: string }>(
        `insert into platform.audiences (organization_id, app_id, environment_id, name, description, definition, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
        [ctx.organizationId, env.app_id, environmentId, audience.name, audience.description, JSON.stringify(audience.definition), ctx.userId],
      );
      audienceId = row!.id;
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "audience.created", targetType: "audience", targetId: audienceId, metadata: { environment_id: environmentId, name: audience.name, template: id.data } });
      definition = { ...definition, trigger: { type: "audience_entered", audienceId } };
    }
    const created = await insertAutomation(db, ctx, environmentId, name, parseDef(definition), { template: id.data, audienceId: audienceId ?? undefined });
    return { id: created.id, audienceId };
  });
}

/** Saves a new version. Runs in progress continue on the version they started with. */
export async function updateAutomation(ctx: TenantContext, id: string, input: { name?: unknown; definition?: unknown }): Promise<{ version: number }> {
  const name = parseName(input.name);
  const definition = parseDef(input.definition);
  return tenantTx(ctx, "automations.manage", async (db) => {
    const cur = await db.one<{ environment_id: string; status: string; version: number; definition: unknown; trigger_type: string }>(
      "select environment_id, status, version, definition, definition->'trigger'->>'type' as trigger_type from platform.automations where id = $1 for update",
      [id],
    );
    if (!cur || cur.status === "archived") throw new NotFoundError("Automation");
    await checkReferences(db, cur.environment_id, definition, { requireActive: cur.status === "active" });
    const changed = JSON.stringify(cur.definition) !== JSON.stringify(definition);
    const version = changed ? cur.version + 1 : cur.version;
    const triggerChanged = changed && JSON.stringify((cur.definition as AutomationDefinition).trigger) !== JSON.stringify(definition.trigger);
    await db.query("update platform.automations set name = $2, definition = $3, version = $4, updated_by = $5 where id = $1", [id, name, JSON.stringify(definition), version, ctx.userId]);
    if (changed) {
      await db.query(
        "insert into platform.automation_versions (organization_id, automation_id, version, definition, created_by) values ($1, $2, $3, $4, $5)",
        [ctx.organizationId, id, version, JSON.stringify(definition), ctx.userId],
      );
    }
    await syncAutomationMedia(db, ctx, id, definition);
    // A new trigger starts from now, never from history.
    if (triggerChanged && cur.status !== "draft") await resetTrigger(db, ctx, id, cur.environment_id, definition);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.updated", targetType: "automation", targetId: id, metadata: { name, version } });
    return { version };
  });
}

/** Points the trigger at "now": only events / transitions after this moment start runs. */
async function resetTrigger(db: Db, ctx: TenantContext, id: string, environmentId: string, d: AutomationDefinition) {
  let cursor: string | null = null;
  let nextFire: Date | null = null;
  if (d.trigger.type === "event") {
    cursor = (await db.one<{ max: string }>("select coalesce(max(id), 0) as max from platform.events where environment_id = $1", [environmentId]))!.max;
  } else if (d.trigger.type === "audience_entered" || d.trigger.type === "audience_exited") {
    cursor = (await db.one<{ max: string }>("select coalesce(max(id), 0) as max from platform.audience_events where audience_id = $1", [d.trigger.audienceId]))!.max;
  } else if (d.trigger.type === "inbound_message") {
    // Replies received from now on (not ones that arrived before activation).
    cursor = (await db.one<{ max: string }>("select coalesce(max(id), 0) as max from platform.inbound_messages where environment_id = $1", [environmentId]))!.max;
  } else if (d.trigger.type === "once") {
    // A time already past means "send now". A send that already went out (cursor set) never goes out again.
    await db.query("update platform.automations set next_fire_at = case when trigger_cursor is null then $2::timestamptz end where id = $1", [id, new Date(Math.max(Date.parse(d.trigger.at), Date.now()))]);
    return;
  } else {
    const org = await db.one<{ timezone: string }>("select timezone from platform.organizations where id = $1", [ctx.organizationId]);
    nextFire = nextScheduled(new Date(), org?.timezone ?? "UTC", d.trigger);
  }
  await db.query("update platform.automations set trigger_cursor = $2, next_fire_at = $3 where id = $1", [id, cursor, nextFire]);
}

/** Starts (or resumes) an automation. Resuming doesn't replay what happened while it was paused. */
export async function activateAutomation(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const a = await db.one<{ environment_id: string; status: string; definition: AutomationDefinition }>(
      "select environment_id, status, definition from platform.automations where id = $1 for update",
      [id],
    );
    if (!a) throw new NotFoundError("Automation");
    if (a.status !== "draft" && a.status !== "paused") throw new ConflictError(msg("Only a draft or paused automation can be activated."));
    const definition = parseDef(a.definition);
    await checkReferences(db, a.environment_id, definition, { requireActive: true });
    await resetTrigger(db, ctx, id, a.environment_id, definition);
    await db.query("update platform.automations set status = 'active', activated_at = now(), updated_by = $2 where id = $1", [id, ctx.userId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.activated", targetType: "automation", targetId: id, metadata: { resumed: a.status === "paused" } });
  });
}

/** Pausing stops new runs and holds runs in progress where they are until resumed. */
export async function pauseAutomation(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "automations.manage", async (db) => {
    const row = await db.one("update platform.automations set status = 'paused', updated_by = $2 where id = $1 and status = 'active' returning id", [id, ctx.userId]);
    if (!row) throw new ConflictError(msg("Only an active automation can be paused."));
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.paused", targetType: "automation", targetId: id });
  });
}

/** Archiving is the kill switch: no new runs, and runs in progress are cancelled. */
export async function archiveAutomation(ctx: TenantContext, id: string): Promise<{ cancelled: number }> {
  return tenantTx(ctx, "automations.manage", async (db) => {
    const row = await db.one("update platform.automations set status = 'archived', updated_by = $2 where id = $1 and status <> 'archived' returning id", [id, ctx.userId]);
    if (!row) throw new NotFoundError("Automation");
    const cancelled = await db.query(
      `update platform.automation_runs set status = 'cancelled', finished_at = now(), next_run_at = null,
              log = log || jsonb_build_array(jsonb_build_object('at', now(), 'step', null, 'type', 'run', 'outcome', 'cancelled', 'detail', 'Automation archived'))
        where automation_id = $1 and status in ('pending', 'waiting', 'running') returning 1`,
      [id],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.archived", targetType: "automation", targetId: id, metadata: { cancelled_runs: cancelled.length } });
    return { cancelled: cancelled.length };
  });
}

export async function getVersion(ctx: TenantContext, id: string, version: number): Promise<AutomationDefinition> {
  return tenantTx(ctx, "automations.read", async (db) => {
    const row = await db.one<{ definition: AutomationDefinition }>("select definition from platform.automation_versions where automation_id = $1 and version = $2", [id, version]);
    if (!row) throw new NotFoundError("Version");
    return row.definition;
  });
}

export interface GoalReport {
  goal: { event: string; withinDays: number; stopOnConversion: boolean };
  /** Runs started (people who entered), all versions. */
  entered: number;
  /** Of those, people who did the goal event within the window after their trigger. */
  converted: number;
  /** Runs still inside their window that haven't converted yet (may still convert). */
  open: number;
  /** Runs ended early because the person converted. */
  stopped: number;
  /** Median time from trigger to conversion, in seconds. */
  medianSeconds: number | null;
}

/**
 * Conversion goal results of a flow, from the event stream: a run converts
 * when its person does the goal event (counted events only) after the
 * trigger and within the goal window. Null when the flow has no goal.
 */
export async function goalReport(ctx: TenantContext, id: string): Promise<GoalReport | null> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Automation");
  return tenantTx(ctx, "automations.read", async (db) => {
    const a = await db.one<{ definition: AutomationDefinition }>("select definition from platform.automations where id = $1", [id]);
    if (!a) throw new NotFoundError("Automation");
    const goal = parseDef(a.definition).goal;
    if (!goal) return null;
    const row = await db.one<{ entered: number; converted: number; open: number; stopped: number; median: number | null }>(
      `with runs as (
         select r.id, r.user_key, r.environment_id, r.log,
                least(coalesce(nullif(r.trigger_data->>'timestamp', '')::timestamptz, nullif(r.trigger_data->>'occurred_at', '')::timestamptz,
                               nullif(r.trigger_data->>'scheduled_for', '')::timestamptz, r.started_at), r.started_at) as t0
           from platform.automation_runs r where r.automation_id = $1),
       conv as (
         select runs.id, runs.t0, runs.log,
                (select min(e."timestamp") from platform.events e ${PERSON.join}
                  where e.environment_id = runs.environment_id and ${COUNTED_EVENTS}
                    and coalesce(e.canonical_name, e.event_name) = $2
                    and e."timestamp" >= runs.t0 and e."timestamp" < runs.t0 + make_interval(days => $3)
                    and ${PERSON.expr} = runs.user_key) as converted_at
           from runs)
       select count(*)::int as entered,
              count(converted_at)::int as converted,
              count(*) filter (where converted_at is null and t0 + make_interval(days => $3) > now())::int as open,
              count(*) filter (where exists (select 1 from jsonb_array_elements(log) x where x->>'detail' like 'Converted:%'))::int as stopped,
              percentile_cont(0.5) within group (order by extract(epoch from converted_at - t0)) as median
         from conv`,
      [id, goal.event, goal.withinDays],
    );
    return { goal, entered: row!.entered, converted: row!.converted, open: row!.open, stopped: row!.stopped, medianSeconds: row!.median === null ? null : Math.round(Number(row!.median)) };
  });
}
