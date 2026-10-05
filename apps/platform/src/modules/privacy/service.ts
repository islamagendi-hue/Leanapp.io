import "server-only";
import { z } from "zod";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { assertCan } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

/**
 * End-user privacy requests (GDPR / PDPL style access and erasure) for one
 * environment of one app.
 *
 * A subject is a `user_id` (the customer's id for the person), an
 * `anonymous_id` (one install), or both. Which rows belong to the subject:
 *
 * - everything carrying the user_id;
 * - anonymous activity (no user_id) of the subject's own installs: the given
 *   anonymous_id, plus installs linked to the user_id that no other user is
 *   linked to. On a shared device we can't tell whose anonymous activity it
 *   was, so we leave it alone rather than delete another person's data;
 * - identified activity of other users is never touched, even on the same install.
 *
 * Every query runs under RLS as the organization (withTenant), so a request
 * can't reach another tenant's rows whatever the input.
 */

export const subjectSchema = z
  .object({
    userId: z.string().trim().max(256).optional().transform((v) => v || undefined),
    anonymousId: z.string().trim().max(256).optional().transform((v) => v || undefined),
  })
  .refine((s) => s.userId || s.anonymousId, "Provide a user_id, an anonymous_id, or both.");
export type Subject = z.infer<typeof subjectSchema>;

/** Who is asking: a dashboard member, or a secret API key of the environment. */
export type Requester =
  | { kind: "user"; ctx: TenantContext }
  | { kind: "api_key"; organizationId: string; environmentId: string; keyId: string };

function parseSubject(input: unknown): Subject {
  const r = subjectSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid subject.");
  return r.data;
}

function scope(req: Requester) {
  if (req.kind === "user") {
    assertCan(req.ctx.role, "privacy.manage");
    return { organizationId: req.ctx.organizationId, userId: req.ctx.userId };
  }
  return { organizationId: req.organizationId, userId: null };
}

function auditActor(req: Requester) {
  return req.kind === "user"
    ? { actorUserId: req.ctx.userId, actorType: "user" as const }
    : { actorUserId: null, actorType: "api_key" as const };
}

async function assertEnvironment(db: Db, environmentId: string): Promise<{ app_id: string }> {
  const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
  if (!env) throw new NotFoundError("Environment");
  return env;
}

interface Resolved {
  userIds: string[];
  /** Installs whose anonymous activity belongs to the subject (see the module comment). */
  anonymousIds: string[];
  userKeys: string[];
}

async function resolveSubject(db: Db, environmentId: string, s: Subject): Promise<Resolved> {
  const userIds = s.userId ? [s.userId] : [];
  const anon = new Set(s.anonymousId ? [s.anonymousId] : []);
  if (userIds.length) {
    const linked = await db.query<{ anonymous_id: string }>(
      `select anonymous_id from platform.identity_links l
        where l.environment_id = $1 and l.user_id = any($2)
          and not exists (select 1 from platform.identity_links o
                           where o.environment_id = l.environment_id and o.anonymous_id = l.anonymous_id and o.user_id <> all($2))`,
      [environmentId, userIds],
    );
    for (const r of linked) anon.add(r.anonymous_id);
  }
  const anonymousIds = [...anon];
  return { userIds, anonymousIds, userKeys: [...userIds, ...anonymousIds.map((a) => `anon:${a}`)] };
}

/** Tables holding the subject's rows and the predicate selecting them. $1 env, $2 user ids, $3 anonymous ids, $4 user keys. */
const SUBJECT_TABLES: { table: string; label: string; where: string; order?: string }[] = [
  ...["events", "sessions", "push_tokens", "attribution_touchpoints", "attribution_events"].map((table) => ({
    table,
    label: table,
    where: "environment_id = $1 and (user_id = any($2) or (user_id is null and anonymous_id = any($3)))",
    order: table === "events" ? '"timestamp" desc' : undefined,
  })),
  { table: "app_users", label: "profiles", where: "environment_id = $1 and external_id = any($2)" },
  { table: "anonymous_users", label: "installs", where: "environment_id = $1 and anonymous_id = any($3)" },
  { table: "identity_links", label: "identity_links", where: "environment_id = $1 and user_id = any($2)" },
  { table: "consent_records", label: "consent_records", where: "environment_id = $1 and user_key = any($4)" },
  { table: "notifications", label: "notifications", where: "environment_id = $1 and user_key = any($4)" },
  {
    table: "audience_members",
    label: "audience_memberships",
    where: "user_key = any($4) and audience_id in (select id from platform.audiences where environment_id = $1)",
  },
  {
    table: "automation_runs",
    label: "automation_runs",
    where: "user_key = any($4) and automation_id in (select id from platform.automations where environment_id = $1)",
  },
];

/** The table's predicate with only the parameters it uses, renumbered ($1 env, $2 user ids, $3 anonymous ids, $4 user keys). */
function bind(where: string, environmentId: string, r: Resolved): { sql: string; values: unknown[] } {
  const all = [environmentId, r.userIds, r.anonymousIds, r.userKeys];
  const used = [...new Set([...where.matchAll(/\$(\d)/g)].map((m) => Number(m[1])))].sort();
  return { sql: where.replace(/\$(\d)/g, (_, n) => `$${used.indexOf(Number(n)) + 1}`), values: used.map((n) => all[n - 1]) };
}

// ── Export ──────────────────────────────────────────────────────────────────
export const EXPORT_ROW_LIMIT = 10_000;

export interface SubjectExport {
  request_id: string;
  generated_at: string;
  environment_id: string;
  subject: { user_id: string | null; anonymous_id: string | null; matched_anonymous_ids: string[] };
  /** Rows per table (events newest first), at most EXPORT_ROW_LIMIT each; `truncated` lists tables that hit the limit. */
  data: Record<string, Record<string, unknown>[]>;
  truncated: string[];
}

/** Collects everything stored about the subject, and records the request. */
export async function exportSubjectData(req: Requester, environmentId: string, input: unknown): Promise<SubjectExport> {
  const s = parseSubject(input);
  if (req.kind === "api_key" && req.environmentId !== environmentId) throw new NotFoundError("Environment");
  return withTenant(scope(req), async (db) => {
    await assertEnvironment(db, environmentId);
    const resolved = await resolveSubject(db, environmentId, s);
    const data: SubjectExport["data"] = {};
    const truncated: string[] = [];
    for (const t of SUBJECT_TABLES) {
      const q = bind(t.where, environmentId, resolved);
      const rows = await db.query(`select * from platform.${t.table} where ${q.sql} order by ${t.order ?? "1"} limit ${EXPORT_ROW_LIMIT + 1}`, q.values);
      if (rows.length > EXPORT_ROW_LIMIT) {
        rows.length = EXPORT_ROW_LIMIT;
        truncated.push(t.label);
      }
      data[t.label] = rows.map(({ organization_id: _o, ...rest }) => rest);
    }
    const request = await db.one<{ id: string }>(
      `insert into platform.privacy_requests (organization_id, environment_id, kind, subject_user_id, subject_anonymous_id, status, requested_by, completed_at)
       values ($1, $2, 'export', $3, $4, 'completed', $5, now()) returning id`,
      [scope(req).organizationId, environmentId, s.userId ?? null, s.anonymousId ?? null, req.kind === "user" ? req.ctx.userId : null],
    );
    await audit(db, {
      organizationId: scope(req).organizationId,
      ...auditActor(req),
      action: "privacy.export",
      targetType: "privacy_request",
      targetId: request!.id,
      metadata: { environment_id: environmentId, rows: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) },
    });
    return {
      request_id: request!.id,
      generated_at: new Date().toISOString(),
      environment_id: environmentId,
      subject: { user_id: s.userId ?? null, anonymous_id: s.anonymousId ?? null, matched_anonymous_ids: resolved.anonymousIds },
      data,
      truncated,
    };
  });
}

// ── Deletion ────────────────────────────────────────────────────────────────
export interface DeletionStatus {
  id: string;
  status: "received" | "processing" | "completed" | "rejected";
  subject: { user_id: string | null; anonymous_id: string | null };
  created_at: Date;
  completed_at: Date | null;
  job: { status: "queued" | "running" | "completed" | "failed"; attempts: number; rows_deleted: number; details: Record<string, number>; error: string | null } | null;
}

/** Queues deletion of everything stored about the subject. The caller runs the job (runDeletionJobs) after responding; the cron worker retries it. */
export async function requestDeletion(req: Requester, environmentId: string, input: unknown): Promise<{ id: string; jobId: string }> {
  const s = parseSubject(input);
  if (req.kind === "api_key" && req.environmentId !== environmentId) throw new NotFoundError("Environment");
  const { organizationId } = scope(req);
  return withTenant(scope(req), async (db) => {
    await assertEnvironment(db, environmentId);
    const request = await db.one<{ id: string }>(
      `insert into platform.privacy_requests (organization_id, environment_id, kind, subject_user_id, subject_anonymous_id, requested_by)
       values ($1, $2, 'deletion', $3, $4, $5) returning id`,
      [organizationId, environmentId, s.userId ?? null, s.anonymousId ?? null, req.kind === "user" ? req.ctx.userId : null],
    );
    const job = await db.one<{ id: string }>(
      "insert into platform.data_deletion_jobs (organization_id, environment_id, privacy_request_id) values ($1, $2, $3) returning id",
      [organizationId, environmentId, request!.id],
    );
    await audit(db, {
      organizationId,
      ...auditActor(req),
      action: "privacy.deletion_requested",
      targetType: "privacy_request",
      targetId: request!.id,
      metadata: { environment_id: environmentId },
    });
    return { id: request!.id, jobId: job!.id };
  });
}

const STATUS_SQL = `
  select r.id, r.status, r.subject_user_id, r.subject_anonymous_id, r.created_at, r.completed_at,
         j.status as job_status, j.attempts, j.rows_deleted, j.details, j.error
    from platform.privacy_requests r
    left join platform.data_deletion_jobs j on j.privacy_request_id = r.id`;

type StatusRow = {
  id: string; status: DeletionStatus["status"]; subject_user_id: string | null; subject_anonymous_id: string | null;
  created_at: Date; completed_at: Date | null; job_status: NonNullable<DeletionStatus["job"]>["status"] | null;
  attempts: number | null; rows_deleted: string | number | null; details: Record<string, number> | null; error: string | null;
};

function toStatus(r: StatusRow): DeletionStatus {
  return {
    id: r.id,
    status: r.status,
    subject: { user_id: r.subject_user_id, anonymous_id: r.subject_anonymous_id },
    created_at: r.created_at,
    completed_at: r.completed_at,
    job: r.job_status
      ? { status: r.job_status, attempts: r.attempts ?? 0, rows_deleted: Number(r.rows_deleted ?? 0), details: r.details ?? {}, error: r.error }
      : null,
  };
}

const uuid = z.string().uuid();

export async function getDeletion(req: Requester, environmentId: string, id: string): Promise<DeletionStatus> {
  if (!uuid.safeParse(id).success) throw new NotFoundError("Deletion request");
  const row = await withTenant(scope(req), (db) =>
    db.one<StatusRow>(`${STATUS_SQL} where r.id = $1 and r.environment_id = $2 and r.kind = 'deletion'`, [id, environmentId]),
  );
  if (!row) throw new NotFoundError("Deletion request");
  return toStatus(row);
}

export interface PrivacyRequestRow {
  id: string;
  kind: "export" | "deletion";
  subject_user_id: string | null;
  subject_anonymous_id: string | null;
  status: DeletionStatus["status"];
  requested_by_name: string | null;
  created_at: Date;
  completed_at: Date | null;
  rows_deleted: number | null;
  job_status: string | null;
  error: string | null;
}

export async function listPrivacyRequests(ctx: TenantContext, environmentId: string, limit = 50): Promise<PrivacyRequestRow[]> {
  assertCan(ctx.role, "privacy.manage");
  const rows = await withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, (db) =>
    db.query<PrivacyRequestRow & { rows_deleted: string | null }>(
      `select r.id, r.kind, r.subject_user_id, r.subject_anonymous_id, r.status, u.name as requested_by_name,
              r.created_at, r.completed_at, j.rows_deleted, j.status as job_status, j.error
         from platform.privacy_requests r
         left join platform.users u on u.id = r.requested_by
         left join platform.data_deletion_jobs j on j.privacy_request_id = r.id
        where r.environment_id = $1
        order by r.created_at desc limit $2`,
      [environmentId, limit],
    ),
  );
  return rows.map((r) => ({ ...r, rows_deleted: r.rows_deleted === null ? null : Number(r.rows_deleted) }));
}

const MAX_ATTEMPTS = 3;
/** A job left "running" this long is assumed to have crashed and is retried. */
const STALE_RUNNING = "15 minutes";

/**
 * Claims and runs queued deletion jobs. Each job deletes in one transaction
 * under the organization's RLS scope, so it either fully happens or is retried.
 */
export async function runDeletionJobs(opts: { limit?: number; jobIds?: string[] } = {}): Promise<{ completed: number; failed: number }> {
  const claimed = await withSystem((db) =>
    db.query<{ id: string; organization_id: string; environment_id: string; privacy_request_id: string; attempts: number }>(
      `update platform.data_deletion_jobs j set status = 'running', started_at = now(), attempts = attempts + 1
        where j.id in (
          select id from platform.data_deletion_jobs
           where (status = 'queued' or (status = 'running' and started_at < now() - interval '${STALE_RUNNING}'))
             and privacy_request_id is not null
             and ($2::uuid[] is null or id = any($2))
           order by created_at limit $1
           for update skip locked)
        returning j.id, j.organization_id, j.environment_id, j.privacy_request_id, j.attempts`,
      [opts.limit ?? 20, opts.jobIds ?? null],
    ),
  );
  let completed = 0;
  let failed = 0;
  for (const job of claimed) {
    try {
      await withTenant({ organizationId: job.organization_id, userId: null }, async (db) => {
        await db.query("update platform.privacy_requests set status = 'processing' where id = $1", [job.privacy_request_id]);
        const req = await db.one<{ subject_user_id: string | null; subject_anonymous_id: string | null }>(
          "select subject_user_id, subject_anonymous_id from platform.privacy_requests where id = $1",
          [job.privacy_request_id],
        );
        const resolved = await resolveSubject(db, job.environment_id, {
          userId: req?.subject_user_id ?? undefined,
          anonymousId: req?.subject_anonymous_id ?? undefined,
        });
        const details: Record<string, number> = {};
        let total = 0;
        for (const t of SUBJECT_TABLES) {
          const q = bind(t.where, job.environment_id, resolved);
          const rows = await db.query(`delete from platform.${t.table} where ${q.sql} returning 1`, q.values);
          details[t.label] = rows.length;
          total += rows.length;
        }
        await db.query(
          "update platform.data_deletion_jobs set status = 'completed', rows_deleted = $2, details = $3, error = null, finished_at = now() where id = $1",
          [job.id, total, JSON.stringify(details)],
        );
        await db.query("update platform.privacy_requests set status = 'completed', completed_at = now() where id = $1", [job.privacy_request_id]);
        await audit(db, {
          organizationId: job.organization_id,
          actorUserId: null,
          actorType: "system",
          action: "privacy.deletion_completed",
          targetType: "privacy_request",
          targetId: job.privacy_request_id,
          metadata: { environment_id: job.environment_id, rows_deleted: total, details },
        });
      });
      completed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error("[privacy] deletion job failed", job.id, message);
      await withSystem((db) =>
        db.query("update platform.data_deletion_jobs set status = $2, error = $3, finished_at = case when $2 = 'failed' then now() end where id = $1", [
          job.id,
          job.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
          message.slice(0, 500),
        ]),
      );
    }
  }
  return { completed, failed };
}
