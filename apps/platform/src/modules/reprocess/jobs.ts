import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { growthConfig, rebuildPersons } from "@/modules/growth/engine";

/**
 * Background re-processing (app_reprocess_jobs), run by the scheduled worker
 * in small committed chunks under each environment's processing lock, so it
 * never races event processing and never holds locks for long.
 *
 *   remap           rewrites events.canonical_name from the accepted mappings
 *                   for every event of the environment (the instant pass after
 *                   a mapping change only covers 30 days / 5,000 events).
 *                   Only canonical_name changes: raw names, validation results
 *                   and lifetime implementation counters are left as they are.
 *   growth_rebuild  recomputes growth_state for every person: identified users,
 *                   then installs, then removes rows nobody owns any more.
 *
 * One active job per environment and kind. Asking again while one is active
 * restarts it from the beginning (the newest mappings or definitions win).
 */

export type ReprocessKind = "remap" | "growth_rebuild";

export const REMAP_CHUNK = 5_000;
export const REBUILD_CHUNK = 500;
const MAX_ATTEMPTS = 5;

/** Queues (or restarts) a job of this kind for every environment of the app. Works under tenant or system scope. */
export async function enqueueReprocess(db: Db, appId: string, kind: ReprocessKind, reason: string, requestedBy: string | null = null): Promise<void> {
  await db.query(
    `update platform.app_reprocess_jobs
        set status = 'queued', cursor = '{}', upto_event_id = null, done_count = 0, total_estimate = null, attempts = 0,
            last_error = null, reason = $3, requested_by = $4, started_at = null, updated_at = now()
      where app_id = $1 and kind = $2 and status in ('queued', 'running')`,
    [appId, kind, reason, requestedBy],
  );
  await db.query(
    `insert into platform.app_reprocess_jobs (organization_id, app_id, environment_id, kind, reason, requested_by)
     select organization_id, app_id, id, $2, $3, $4 from platform.environments where app_id = $1
     on conflict (environment_id, kind) where status in ('queued', 'running') do nothing`,
    [appId, kind, reason, requestedBy],
  );
}

export interface ReprocessJob {
  id: string;
  environment_id: string;
  kind: ReprocessKind;
  status: "queued" | "running" | "done" | "failed";
  reason: string;
  done_count: number;
  total_estimate: number | null;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Latest job per environment and kind for an app (for progress on the dashboard). */
export function latestJobs(db: Db, appId: string): Promise<ReprocessJob[]> {
  return db.query<ReprocessJob>(
    `select distinct on (environment_id, kind) id, environment_id, kind, status, reason, done_count::float8 as done_count,
            total_estimate::float8 as total_estimate, last_error, created_at, finished_at
       from platform.app_reprocess_jobs where app_id = $1
      order by environment_id, kind, created_at desc`,
    [appId],
  );
}

interface JobRow {
  id: string;
  app_id: string;
  environment_id: string;
  kind: ReprocessKind;
  status: string;
  cursor: { after?: string; stage?: "users" | "anons" | "cleanup" };
  upto_event_id: string | null;
  started_at: Date | null;
  attempts: number;
}

type ChunkResult = "more" | "done" | "busy";

/** Runs queued jobs chunk by chunk until there are none or the deadline (epoch ms) passes. */
export async function runReprocessJobs(opts: { deadline: number; maxChunks?: number }): Promise<{ chunks: number; finished: number; failed: number }> {
  const pending = await withSystem((db) =>
    db.query<{ id: string }>("select id from platform.app_reprocess_jobs where status in ('queued', 'running') order by created_at limit 50"),
  );
  let chunks = 0;
  let finished = 0;
  let failed = 0;
  for (const { id } of pending) {
    while (Date.now() < opts.deadline && chunks < (opts.maxChunks ?? Infinity)) {
      let result: ChunkResult | "failed";
      try {
        result = await withSystem((db) => runChunk(db, id));
      } catch (err) {
        const message = String((err as Error).message).slice(0, 500);
        log.error("reprocess.chunk_failed", { job: id, error: message });
        const r = await withSystem((db) =>
          db.one<{ status: string }>(
            `update platform.app_reprocess_jobs set attempts = attempts + 1, last_error = $2, updated_at = now(),
                    status = case when attempts + 1 >= $3 then 'failed' else status end,
                    finished_at = case when attempts + 1 >= $3 then now() end
              where id = $1 returning status`,
            [id, message, MAX_ATTEMPTS],
          ),
        );
        result = r?.status === "failed" ? "failed" : "busy";
      }
      if (result !== "busy") chunks++;
      if (result === "done") finished++;
      if (result === "failed") failed++;
      if (result !== "more") break;
    }
    if (Date.now() >= opts.deadline) break;
  }
  return { chunks, finished, failed };
}

async function runChunk(db: Db, jobId: string): Promise<ChunkResult> {
  const job = await db.one<JobRow>(
    `select id, app_id, environment_id, kind, status, cursor, upto_event_id, started_at, attempts
       from platform.app_reprocess_jobs where id = $1 and status in ('queued', 'running') for update skip locked`,
    [jobId],
  );
  if (!job) return "busy";
  // Same lock as event processing: wait for nobody, skip if a worker holds it.
  const lock = await db.one<{ ok: boolean }>(
    "select pg_try_advisory_xact_lock(hashtextextended('platform.events.processing:' || $1, 0)) as ok",
    [job.environment_id],
  );
  if (!lock?.ok) return "busy";
  if (job.status === "queued") {
    const started = await db.one<{ started_at: Date; upto: string | null; total: string }>(
      `update platform.app_reprocess_jobs j set status = 'running', started_at = now(), updated_at = now(),
              upto_event_id = case when j.kind = 'remap' then (select max(id) from platform.events where environment_id = j.environment_id) end,
              total_estimate = case when j.kind = 'remap'
                                    then (select count(*) from platform.events where environment_id = j.environment_id)
                                    else (select count(*) from platform.app_users where environment_id = j.environment_id)
                                       + (select count(*) from platform.anonymous_users where environment_id = j.environment_id) end
        where id = $1 returning started_at, upto_event_id as upto, total_estimate as total`,
      [job.id],
    );
    job.started_at = started!.started_at;
    job.upto_event_id = started!.upto;
  }
  return job.kind === "remap" ? remapChunk(db, job) : rebuildChunk(db, job);
}

async function finish(db: Db, job: JobRow): Promise<ChunkResult> {
  await db.query("update platform.app_reprocess_jobs set status = 'done', finished_at = now(), updated_at = now() where id = $1", [job.id]);
  return "done";
}

async function remapChunk(db: Db, job: JobRow): Promise<ChunkResult> {
  if (!job.upto_event_id) return finish(db, job); // no events
  const after = job.cursor.after ?? "0";
  const r = await db.one<{ last: string | null; n: string; changed: string }>(
    `with chunk as (
       select id, event_name from platform.events
        where environment_id = $1 and id > $2 and id <= $3
        order by id limit $5),
     target as (
       select c.id, (select m.to_name from platform.event_mappings m
                      where m.app_id = $4 and m.status = 'accepted' and m.from_name = c.event_name and m.to_name <> c.event_name) as canonical
         from chunk c),
     upd as (
       update platform.events e set canonical_name = t.canonical
         from target t where e.id = t.id and e.canonical_name is distinct from t.canonical
       returning 1)
     select (select max(id) from chunk)::text as last, (select count(*) from chunk) as n, (select count(*) from upd) as changed`,
    [job.environment_id, after, job.upto_event_id, job.app_id, REMAP_CHUNK],
  );
  const n = Number(r?.n ?? 0);
  await db.query(
    "update platform.app_reprocess_jobs set cursor = jsonb_build_object('after', $2::text), done_count = done_count + $3, updated_at = now() where id = $1",
    [job.id, r?.last ?? after, n],
  );
  if (n < REMAP_CHUNK) {
    // Canonical names feed the growth definitions: rebuild growth state on top.
    if (await growthConfig(db, job.app_id)) await enqueueRebuildForEnvironment(db, job, "re-map finished");
    return finish(db, job);
  }
  return "more";
}

async function enqueueRebuildForEnvironment(db: Db, job: JobRow, reason: string) {
  await db.query(
    `update platform.app_reprocess_jobs
        set status = 'queued', cursor = '{}', done_count = 0, total_estimate = null, attempts = 0, last_error = null, reason = $2, started_at = null, updated_at = now()
      where environment_id = $1 and kind = 'growth_rebuild' and status in ('queued', 'running')`,
    [job.environment_id, reason],
  );
  await db.query(
    `insert into platform.app_reprocess_jobs (organization_id, app_id, environment_id, kind, reason)
     select organization_id, app_id, id, 'growth_rebuild', $2 from platform.environments where id = $1
     on conflict (environment_id, kind) where status in ('queued', 'running') do nothing`,
    [job.environment_id, reason],
  );
}

async function rebuildChunk(db: Db, job: JobRow): Promise<ChunkResult> {
  const cfg = await growthConfig(db, job.app_id);
  if (!cfg) return finish(db, job); // growth_model was turned off meanwhile
  const stage = job.cursor.stage ?? "users";
  const after = job.cursor.after ?? "";
  if (stage === "cleanup") {
    // Rows not rebuilt since the job started belong to nobody any more.
    await db.query("delete from platform.growth_state where environment_id = $1 and updated_at < $2", [job.environment_id, job.started_at]);
    return finish(db, job);
  }
  const ids =
    stage === "users"
      ? (await db.query<{ id: string }>(
          "select external_id as id from platform.app_users where environment_id = $1 and external_id > $2 order by external_id limit $3",
          [job.environment_id, after, REBUILD_CHUNK],
        )).map((r) => r.id)
      : (await db.query<{ id: string }>(
          "select anonymous_id as id from platform.anonymous_users where environment_id = $1 and anonymous_id > $2 order by anonymous_id limit $3",
          [job.environment_id, after, REBUILD_CHUNK],
        )).map((r) => r.id);
  await rebuildPersons(db, cfg, job.environment_id, stage === "users" ? ids : ids.map((a) => `anon:${a}`));
  const next = ids.length < REBUILD_CHUNK ? { stage: stage === "users" ? "anons" : "cleanup", after: "" } : { stage, after: ids[ids.length - 1] };
  await db.query("update platform.app_reprocess_jobs set cursor = $2, done_count = done_count + $3, updated_at = now() where id = $1", [
    job.id,
    JSON.stringify(next),
    ids.length,
  ]);
  return "more";
}
