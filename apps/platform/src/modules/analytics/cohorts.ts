import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { analyticsTx, loadCohortDefinition } from "./service";
import { cohortDefinitionSchema, cohortSql, Params, type CohortDefinition } from "./sql";

/**
 * Saved cohorts: named definitions of a group of people, per app environment.
 * Members are computed on demand (with the analytics statement timeout), so a
 * cohort is always current and nothing about end users is copied.
 */

export interface Cohort {
  id: string;
  name: string;
  description: string | null;
  definition: CohortDefinition;
  created_at: Date;
  updated_at: Date;
  created_by_name: string | null;
}

export const cohortInputSchema = z.object({
  name: z.string().trim().min(1, "Name the cohort.").max(100),
  description: z.string().trim().max(500).optional().transform((v) => v || null),
  definition: cohortDefinitionSchema,
});

function parseInput(input: unknown) {
  const r = cohortInputSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ValidationError(issue?.message ?? "Invalid cohort.", { [issue?.path.join(".") || "definition"]: issue?.message });
  }
  return r.data;
}

/** The environment's app id, or NotFound when the environment isn't in this organization (RLS). */
async function environmentApp(db: Db, environmentId: string): Promise<string> {
  const row = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
  if (!row) throw new NotFoundError("Environment");
  return row.app_id;
}

function uniqueName<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e: { code?: string }) => {
    if (e?.code === "23505") throw new ConflictError("A cohort with this name already exists in this environment.");
    throw e;
  });
}

const COLUMNS = `c.id, c.name, c.description, c.definition, c.created_at, c.updated_at,
  (select u.name from platform.users u where u.id = c.created_by) as created_by_name`;

export async function listCohorts(ctx: TenantContext, environmentId: string): Promise<Cohort[]> {
  return analyticsTx(ctx, (db) =>
    db.query<Cohort>(`select ${COLUMNS} from platform.analytics_cohorts c where c.environment_id = $1 order by lower(c.name)`, [environmentId]),
  );
}

export async function getCohort(ctx: TenantContext, environmentId: string, id: string): Promise<Cohort> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Cohort");
  return analyticsTx(ctx, async (db) => {
    const row = await db.one<Cohort>(`select ${COLUMNS} from platform.analytics_cohorts c where c.id = $1 and c.environment_id = $2`, [id, environmentId]);
    if (!row) throw new NotFoundError("Cohort");
    return row;
  });
}

export async function createCohort(ctx: TenantContext, environmentId: string, input: unknown): Promise<{ id: string }> {
  const data = parseInput(input);
  return analyticsTx(
    ctx,
    async (db) => {
      const appId = await environmentApp(db, environmentId);
      const row = await uniqueName(() =>
        db.one<{ id: string }>(
          `insert into platform.analytics_cohorts (organization_id, app_id, environment_id, name, description, definition, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [ctx.organizationId, appId, environmentId, data.name, data.description, JSON.stringify(data.definition), ctx.userId],
        ),
      );
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "cohort.created", targetType: "cohort", targetId: row!.id, metadata: { name: data.name, environmentId } });
      return { id: row!.id };
    },
    "analytics.write",
  );
}

export async function updateCohort(ctx: TenantContext, environmentId: string, id: string, input: unknown): Promise<void> {
  const data = parseInput(input);
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Cohort");
  await analyticsTx(
    ctx,
    async (db) => {
      const row = await uniqueName(() =>
        db.one<{ id: string }>(
          `update platform.analytics_cohorts set name = $3, description = $4, definition = $5
            where id = $1 and environment_id = $2 returning id`,
          [id, environmentId, data.name, data.description, JSON.stringify(data.definition)],
        ),
      );
      if (!row) throw new NotFoundError("Cohort");
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "cohort.updated", targetType: "cohort", targetId: id, metadata: { name: data.name } });
    },
    "analytics.write",
  );
}

export async function deleteCohort(ctx: TenantContext, environmentId: string, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Cohort");
  await analyticsTx(
    ctx,
    async (db) => {
      const row = await db.one<{ name: string }>("delete from platform.analytics_cohorts where id = $1 and environment_id = $2 returning name", [id, environmentId]);
      if (!row) throw new NotFoundError("Cohort");
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "cohort.deleted", targetType: "cohort", targetId: id, metadata: { name: row.name } });
    },
    "analytics.write",
  );
}

export interface CohortMembers {
  size: number;
  /** Most recently seen first, up to `limit`. */
  sample: { person: string; lastSeen: Date | null }[];
}

/** Size and a sample of members, computed now. Times out like any analytics query (15 s). */
export async function cohortMembers(
  ctx: TenantContext,
  scope: { environmentId: string; timezone: string },
  id: string,
  opts: { limit?: number } = {},
): Promise<CohortMembers> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Cohort");
  const limit = Math.min(Math.max(opts.limit ?? 0, 0), 100);
  return analyticsTx(ctx, async (db) => {
    const def = await loadCohortDefinition(db, scope.environmentId, id).catch((e) => {
      if (e instanceof ValidationError) throw new NotFoundError("Cohort");
      throw e;
    });
    const p = new Params([scope.environmentId]);
    const sql = cohortSql(def, p, { timezone: scope.timezone });
    const size = await db.one<{ n: string }>(`with cohort as (${sql}) select count(*) as n from cohort`, p.values);
    let sample: CohortMembers["sample"] = [];
    if (limit) {
      const lp = p.add(limit);
      sample = (await db.query<{ person: string; last_seen: Date | null }>(
        `with cohort as (${sql})
         select c.person, coalesce(u.last_seen_at, a.last_seen_at) as last_seen
           from cohort c
           left join platform.app_users u on u.environment_id = $1 and u.external_id = c.person
           left join platform.anonymous_users a on a.environment_id = $1 and c.person like 'anon:%' and a.anonymous_id = substr(c.person, 6)
          order by last_seen desc nulls last, c.person limit ${lp}`,
        p.values,
      )).map((r) => ({ person: r.person, lastSeen: r.last_seen }));
    }
    return { size: Number(size!.n), sample };
  });
}

/** Size of a definition that isn't saved yet (preview while editing). */
export async function previewCohortSize(ctx: TenantContext, scope: { environmentId: string; timezone: string }, definition: unknown): Promise<number> {
  const r = cohortDefinitionSchema.safeParse(definition);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid cohort.");
  return analyticsTx(ctx, async (db) => {
    const p = new Params([scope.environmentId]);
    const row = await db.one<{ n: string }>(`with cohort as (${cohortSql(r.data, p, { timezone: scope.timezone })}) select count(*) as n from cohort`, p.values);
    return Number(row!.n);
  });
}
