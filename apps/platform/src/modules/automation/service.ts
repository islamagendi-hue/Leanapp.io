import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { AutomationDefinitionError, parseAutomation, referencedAudiences, referencedEmailTemplates, referencedWebhooks, referencedWhatsAppTemplates, type AutomationDefinition } from "./definition";
import { nextScheduled } from "./time";

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

const nameSchema = z.string().trim().min(2, "Name the automation.").max(80);

function parseDef(input: unknown): AutomationDefinition {
  try {
    return parseAutomation(typeof input === "string" ? JSON.parse(input) : input);
  } catch (err) {
    throw new ValidationError(err instanceof AutomationDefinitionError ? err.message : "The automation is not valid.");
  }
}

function parseName(v: unknown): string {
  const r = nameSchema.safeParse(v);
  if (!r.success) throw new ValidationError(r.error.issues[0].message);
  return r.data;
}

const SELECT = `
  select a.id, a.environment_id, a.name, a.status, a.definition, a.version, a.activated_at, a.next_fire_at, a.created_at, a.updated_at,
         json_build_object(
           'active', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status in ('pending', 'waiting', 'running')),
           'completed', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status = 'completed'),
           'failed', (select count(*) from platform.automation_runs r where r.automation_id = a.id and r.status = 'failed'),
           'total', (select count(*) from platform.automation_runs r where r.automation_id = a.id)) as runs
    from platform.automations a`;

export function listAutomations(ctx: TenantContext, environmentId: string): Promise<AutomationRow[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query<AutomationRow>(`${SELECT} where a.environment_id = $1 order by a.status = 'archived', a.name`, [environmentId]),
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
    if (!a || a.status === "archived") throw new ValidationError("The trigger's audience doesn't exist in this environment.");
    if (opts.requireActive && a.status !== "active") throw new ValidationError(`Activate the audience "${a.name}" first.`);
  }
  for (const id of referencedWebhooks(d)) {
    const w = await db.one("select id from platform.webhooks where id = $1 and environment_id = $2", [id, environmentId]);
    if (!w) throw new ValidationError("A webhook step points to a webhook that doesn't exist in this environment.");
  }
  for (const id of referencedEmailTemplates(d)) {
    const t = await db.one("select id from platform.email_templates where id = $1 and environment_id = $2", [id, environmentId]);
    if (!t) throw new ValidationError("An email step points to a template that doesn't exist in this environment.");
  }
  for (const s of referencedWhatsAppTemplates(d)) {
    const t = await db.one<{ status: string; body_params: number; header_params: number }>(
      "select status, body_params, header_params from platform.whatsapp_templates where environment_id = $1 and name = $2 and language = $3",
      [environmentId, s.template, s.language],
    );
    if (!t) throw new ValidationError(`The WhatsApp template "${s.template}" (${s.language}) isn't synced in this environment. Sync templates on Engage → Integrations.`);
    if (t.body_params !== s.bodyParams.length || t.header_params !== s.headerParams.length) {
      throw new ValidationError(`The WhatsApp template "${s.template}" needs ${t.body_params} body and ${t.header_params} header variables.`);
    }
    if (opts.requireActive && t.status !== "APPROVED") throw new ValidationError(`The WhatsApp template "${s.template}" is ${t.status.toLowerCase()}, not approved by WhatsApp yet.`);
  }
}

export async function createAutomation(ctx: TenantContext, environmentId: string, input: { name?: unknown; definition?: unknown }): Promise<{ id: string }> {
  const name = parseName(input.name);
  const definition = parseDef(input.definition);
  return tenantTx(ctx, "automations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    await checkReferences(db, environmentId, definition, { requireActive: false });
    const row = await db.one<{ id: string }>(
      `insert into platform.automations (organization_id, app_id, environment_id, name, definition, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 1, $6, $6) returning id`,
      [ctx.organizationId, env.app_id, environmentId, name, JSON.stringify(definition), ctx.userId],
    );
    await db.query(
      "insert into platform.automation_versions (organization_id, automation_id, version, definition, created_by) values ($1, $2, 1, $3, $4)",
      [ctx.organizationId, row!.id, JSON.stringify(definition), ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "automation.created", targetType: "automation", targetId: row!.id, metadata: { environment_id: environmentId, name } });
    return { id: row!.id };
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
    if (a.status !== "draft" && a.status !== "paused") throw new ConflictError("Only a draft or paused automation can be activated.");
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
    if (!row) throw new ConflictError("Only an active automation can be paused.");
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
