import "server-only";
import { z } from "zod";
import { msg } from "@/i18n/translate";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { enqueueAudienceDeliveries } from "@/modules/webhooks/service";
import { fill } from "@/modules/automation/messages";
import { compileAudience, DefinitionError, describeNode, parseDefinition, type AudienceNode } from "./definition";

/**
 * Audiences: saved condition trees over the people of one environment.
 *
 * Draft audiences can be previewed (size + sample). Activating one computes
 * membership; the scheduled worker recomputes active audiences every
 * `refresh_minutes`, maintaining audience_members (entered_at / exited_at)
 * and appending each change to audience_events, which automations consume
 * (audience entered / exited triggers) and webhooks deliver. A computation is
 * one set-based statement, so membership and transitions always agree.
 */
const STATEMENT_TIMEOUT = "30s";
const PREVIEW_TIMEOUT = "15s";

export interface AudienceRow {
  id: string;
  environment_id: string;
  name: string;
  description: string | null;
  definition: AudienceNode;
  status: "draft" | "active" | "archived";
  member_count: number;
  refresh_minutes: number;
  last_computed_at: Date | null;
  last_compute_ms: number | null;
  last_compute_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const metaSchema = z.object({
  name: z.string().trim().min(2, msg("Name the audience.")).max(80),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  refreshMinutes: z.coerce.number().int().min(5, msg("Recompute at most every 5 minutes.")).max(1440).default(15),
});

function parseDef(input: unknown): AudienceNode {
  try {
    return parseDefinition(typeof input === "string" ? JSON.parse(input) : input);
  } catch (err) {
    throw new ValidationError(err instanceof DefinitionError ? err.message : msg("The audience definition is not valid."));
  }
}

function parseMeta(input: unknown) {
  const r = metaSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid input."));
  return r.data;
}

const SELECT = `select id, environment_id, name, description, definition, status, member_count::int as member_count, refresh_minutes,
                       last_computed_at, last_compute_ms, last_compute_error, created_at, updated_at from platform.audiences`;

export function listAudiences(ctx: TenantContext, environmentId: string, opts: { includeArchived?: boolean } = {}): Promise<AudienceRow[]> {
  return tenantTx(ctx, "audiences.read", (db) =>
    db.query<AudienceRow>(`${SELECT} where environment_id = $1 and ($2 or status <> 'archived') order by status = 'archived', name`, [environmentId, opts.includeArchived ?? false]),
  );
}

export interface AudienceDetail {
  audience: AudienceRow;
  description: string;
  history: { computed_at: Date; member_count: number; entered: number; exited: number }[];
  members: { user_key: string; entered_at: Date }[];
  recent: { user_key: string; kind: "entered" | "exited"; occurred_at: Date }[];
}

const uuid = z.string().uuid();

export async function getAudience(ctx: TenantContext, id: string): Promise<AudienceDetail> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Audience");
  return tenantTx(ctx, "audiences.read", async (db) => {
    const audience = await db.one<AudienceRow>(`${SELECT} where id = $1`, [id]);
    if (!audience) throw new NotFoundError("Audience");
    const history = await db.query<AudienceDetail["history"][number]>(
      `select computed_at, member_count::int as member_count, entered, exited from (
         select * from platform.audience_snapshots where audience_id = $1 order by computed_at desc limit 96) s order by computed_at`,
      [id],
    );
    const members = await db.query<AudienceDetail["members"][number]>(
      "select user_key, entered_at from platform.audience_members where audience_id = $1 and exited_at is null order by entered_at desc limit 50",
      [id],
    );
    const recent = await db.query<AudienceDetail["recent"][number]>(
      "select user_key, kind, occurred_at from platform.audience_events where audience_id = $1 and not initial order by id desc limit 50",
      [id],
    );
    return { audience, description: describeNode(audience.definition), history, members, recent };
  });
}

export async function createAudience(ctx: TenantContext, environmentId: string, input: { name?: unknown; description?: unknown; refreshMinutes?: unknown; definition?: unknown }): Promise<{ id: string }> {
  const meta = parseMeta(input);
  const definition = parseDef(input.definition);
  return tenantTx(ctx, "audiences.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    const row = await db.one<{ id: string }>(
      `insert into platform.audiences (organization_id, app_id, environment_id, name, description, definition, refresh_minutes, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
      [ctx.organizationId, env.app_id, environmentId, meta.name, meta.description, JSON.stringify(definition), meta.refreshMinutes, ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "audience.created", targetType: "audience", targetId: row!.id, metadata: { environment_id: environmentId, name: meta.name } });
    return { id: row!.id };
  });
}

/** Saves name/definition. An active audience is recomputed by the next worker run; changes caused by the edit don't trigger automations. */
export async function updateAudience(ctx: TenantContext, id: string, input: { name?: unknown; description?: unknown; refreshMinutes?: unknown; definition?: unknown }): Promise<void> {
  const meta = parseMeta(input);
  const definition = parseDef(input.definition);
  await tenantTx(ctx, "audiences.manage", async (db) => {
    const row = await db.one<{ id: string }>(
      `update platform.audiences set name = $2, description = $3, refresh_minutes = $4,
              needs_baseline = needs_baseline or definition is distinct from $5::jsonb,
              last_computed_at = case when definition is distinct from $5::jsonb then null else last_computed_at end,
              definition = $5, updated_by = $6
        where id = $1 and status <> 'archived' returning id`,
      [id, meta.name, meta.description, meta.refreshMinutes, JSON.stringify(definition), ctx.userId],
    );
    if (!row) throw new NotFoundError("Audience");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "audience.updated", targetType: "audience", targetId: id, metadata: { name: meta.name } });
  });
}

/** Size and a sample of the people a definition matches right now (nothing is stored). */
export async function previewAudience(ctx: TenantContext, environmentId: string, definitionInput: unknown): Promise<{ size: number; sample: string[]; description: string }> {
  const definition = parseDef(definitionInput);
  const { sql, params } = compileAudience(definition, environmentId);
  return tenantTx(ctx, "audiences.read", async (db) => {
    await db.query(`set local statement_timeout = '${PREVIEW_TIMEOUT}'`);
    const row = await db.one<{ size: string; sample: string[] | null }>(
      `with target as (${sql}) select (select count(*) from target) as size, (select array_agg(person) from (select person from target order by person limit 20) s) as sample`,
      params,
    );
    return { size: Number(row?.size ?? 0), sample: row?.sample ?? [], description: describeNode(definition) };
  });
}

export async function activateAudience(ctx: TenantContext, id: string): Promise<{ size: number }> {
  await tenantTx(ctx, "audiences.manage", async (db) => {
    const row = await db.one("update platform.audiences set status = 'active', activated_at = coalesce(activated_at, now()), updated_by = $2 where id = $1 and status = 'draft' returning id", [id, ctx.userId]);
    if (!row) throw new ConflictError(msg("Only a draft audience can be activated."));
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "audience.activated", targetType: "audience", targetId: id });
  });
  const result = await withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, (db) => computeAudience(db, id));
  return { size: result?.size ?? 0 };
}

/** Archiving stops recomputation; automations triggered by it stop receiving entries. Members are kept for reference. */
export async function archiveAudience(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "audiences.manage", async (db) => {
    const used = await db.one<{ name: string }>(
      `select name from platform.automations where status in ('active', 'paused') and definition->'trigger'->>'audienceId' = $1::text limit 1`,
      [id],
    );
    if (used) throw new ConflictError(fill(msg('The automation "{name}" uses this audience. Archive or change it first.'), { name: used.name }));
    const row = await db.one("update platform.audiences set status = 'archived', updated_by = $2 where id = $1 and status <> 'archived' returning id", [id, ctx.userId]);
    if (!row) throw new NotFoundError("Audience");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "audience.archived", targetType: "audience", targetId: id });
  });
}

export interface ComputeResult {
  size: number;
  entered: number;
  exited: number;
  ms: number;
}

/**
 * Recomputes one active audience inside the caller's transaction (tenant
 * scope). Locks the audience row with SKIP LOCKED, so concurrent workers skip
 * an audience being computed (and, with onlyIfDue, one just computed);
 * returns null when skipped.
 */
export async function computeAudience(db: Db, id: string, opts: { onlyIfDue?: boolean } = {}): Promise<ComputeResult | null> {
  const a = await db.one<{ id: string; organization_id: string; environment_id: string; name: string; definition: unknown; needs_baseline: boolean }>(
    `select id, organization_id, environment_id, name, definition, needs_baseline from platform.audiences
      where id = $1 and status = 'active'
        and (not $2 or last_computed_at is null or last_computed_at < now() - make_interval(mins => refresh_minutes))
      for update skip locked`,
    [id, opts.onlyIfDue ?? false],
  );
  if (!a) return null;
  const started = Date.now();
  const definition = parseDefinition(a.definition);
  const { sql, params } = compileAudience(definition, a.environment_id);
  const n = params.length;
  await db.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
  const before = await db.one<{ max: string }>("select coalesce(max(id), 0) as max from platform.audience_events where audience_id = $1", [id]);
  const row = await db.one<{ size: string; entered: string; exited: string }>(
    `with target as (${sql}),
     exited as (
       update platform.audience_members m set exited_at = now()
        where m.audience_id = $${n + 2} and m.exited_at is null and not exists (select 1 from target t where t.person = m.user_key)
       returning m.user_key),
     entered as (
       insert into platform.audience_members (organization_id, audience_id, user_key, entered_at)
       select $${n + 1}, $${n + 2}, t.person, now() from target t
       on conflict (audience_id, user_key) do update set entered_at = now(), exited_at = null
        where platform.audience_members.exited_at is not null
       returning user_key),
     ev as (
       insert into platform.audience_events (organization_id, audience_id, user_key, kind, initial)
       select $${n + 1}, $${n + 2}, user_key, 'entered', $${n + 3}::boolean from entered
       union all select $${n + 1}, $${n + 2}, user_key, 'exited', $${n + 3}::boolean from exited
       returning kind)
     select (select count(*) from target) as size,
            (select count(*) from ev where kind = 'entered') as entered,
            (select count(*) from ev where kind = 'exited') as exited`,
    [...params, a.organization_id, id, a.needs_baseline],
  );
  const result: ComputeResult = { size: Number(row!.size), entered: Number(row!.entered), exited: Number(row!.exited), ms: Date.now() - started };
  await db.query(
    `update platform.audiences set member_count = $2, last_computed_at = now(), last_compute_ms = $3, last_compute_error = null, needs_baseline = false where id = $1`,
    [id, result.size, result.ms],
  );
  await db.query(
    "insert into platform.audience_snapshots (organization_id, audience_id, member_count, entered, exited) values ($1, $2, $3, $4, $5) on conflict do nothing",
    [a.organization_id, id, result.size, result.entered, result.exited],
  );
  if (!a.needs_baseline && (result.entered || result.exited)) {
    await enqueueAudienceDeliveries(db, { id, name: a.name, environment_id: a.environment_id }, before!.max);
  }
  return result;
}

/** Scheduled recomputation of active audiences whose refresh interval has passed. Bounded and safe to run concurrently. */
export async function recomputeDueAudiences(opts: { limit?: number; deadline?: number } = {}): Promise<{ computed: number; failed: number }> {
  const due = await withSystem((db) =>
    db.query<{ id: string; organization_id: string }>(
      `select id, organization_id from platform.audiences
        where status = 'active' and (last_computed_at is null or last_computed_at < now() - make_interval(mins => refresh_minutes))
        order by last_computed_at nulls first limit $1`,
      [opts.limit ?? 20],
    ),
  );
  let computed = 0;
  let failed = 0;
  for (const a of due) {
    if (opts.deadline && Date.now() >= opts.deadline) break;
    try {
      const r = await withTenant({ organizationId: a.organization_id, userId: null }, (db) => computeAudience(db, a.id, { onlyIfDue: true }));
      if (r) computed++;
    } catch (err) {
      failed++;
      log.error("audience.compute_failed", { audience_id: a.id, organization_id: a.organization_id, error: err });
      const message = (err as { code?: string }).code === "57014" ? msg("Timed out: simplify the conditions or shorten the time windows.") : msg("Computation failed.");
      await withSystem((db) => db.query("update platform.audiences set last_compute_error = $2, last_computed_at = now() where id = $1", [a.id, message]));
    }
  }
  return { computed, failed };
}

/** Whether one person currently matches a condition (automation branches). Runs in the caller's transaction. */
export async function personMatches(db: Db, environmentId: string, personKey: string, condition: AudienceNode, triggerAt: Date): Promise<boolean> {
  const { sql, params } = compileAudience(condition, environmentId, { personKey, triggerAt });
  const row = await db.one<{ ok: boolean }>(`with target as (${sql}) select exists (select 1 from target) as ok`, params);
  return Boolean(row?.ok);
}
