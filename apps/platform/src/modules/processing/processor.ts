import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { loadPublishedPlan, type PublishedPlan } from "@/modules/implementation/plan-store";
import { suggestMapping } from "@/modules/implementation/similarity";
import { validateEvent } from "@/modules/implementation/validate";
import { SYSTEM_EVENT_NAMES } from "@/modules/ingestion/schema";

/**
 * Asynchronous event processing (the "queue" consumer).
 *
 * Postgres is the queue in phase 1: unprocessed rows are claimed with
 * FOR UPDATE SKIP LOCKED in small committed batches, and workers (the after()
 * hook on each ingestion request plus the scheduled job) are serialized per
 * environment, so no event is processed twice and workers never deadlock.
 *
 * Per event, exactly once:
 *   1. identity: anonymous users, identified users (+ traits), identity links
 *   2. sessions: start/end, event and screen counts, entry source
 *   3. push tokens
 *   4. plan: canonical name via accepted mappings, schema validation,
 *      implementation status, mapping suggestions for unplanned names
 */

export interface EventRow {
  id: string;
  organization_id: string;
  app_id: string;
  environment_id: string;
  type: string;
  event_name: string;
  timestamp: Date;
  anonymous_id: string | null;
  user_id: string | null;
  session_id: string | null;
  platform: string | null;
  app_version: string | null;
  source: string;
  properties: Record<string, unknown>;
  user_properties: Record<string, unknown> | null;
  context: Record<string, unknown>;
}

const SYSTEM_NAMES = new Set(Object.values(SYSTEM_EVENT_NAMES).concat(["app_installed", "app_opened", "app_updated", "deep_link_opened", "push_opened"]));

/** Events claimed per transaction: small enough that locks are held briefly and progress is committed often. */
const BATCH_SIZE = 100;
/** Transient failures (deadlock, serialization) are retried this many times before the event is marked failed. */
export const MAX_PROCESSING_ATTEMPTS = 5;
const TRANSIENT = new Set(["40P01", "40001"]);

/**
 * Drains unprocessed events, one environment at a time and BATCH_SIZE events
 * per transaction. Workers are serialized per environment with a transaction
 * advisory lock: the upserts below share rows (sessions, users, identity links,
 * implementation status) across events, so two workers on one environment
 * would contend and could deadlock. A worker that finds an environment locked
 * skips it; the holder drains it. Stops at `limit` events or `deadline` (epoch ms).
 */
export async function processPendingEvents(
  opts: { limit?: number; environmentId?: string; deadline?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const limit = Math.min(opts.limit ?? 500, 20_000);
  const environments = opts.environmentId
    ? [opts.environmentId]
    : (await withSystem((db) =>
        db.query<{ environment_id: string }>(
          "select environment_id from platform.events where processed_at is null group by environment_id order by min(id)",
        ),
      )).map((r) => r.environment_id);
  let processed = 0;
  let failed = 0;
  let claimed = 0;
  for (const environmentId of environments) {
    while (claimed < limit && !(opts.deadline && Date.now() >= opts.deadline)) {
      const size = Math.min(BATCH_SIZE, limit - claimed);
      const r = await processBatch(environmentId, size);
      if (!r) break; // another worker holds this environment
      processed += r.processed;
      failed += r.failed;
      claimed += r.claimed;
      if (r.claimed < size) break;
    }
  }
  return { processed, failed };
}

async function processBatch(environmentId: string, size: number): Promise<{ claimed: number; processed: number; failed: number } | null> {
  return withSystem(async (db) => {
    // Same key as recomputeImplementation, which waits for it instead of skipping.
    const lock = await db.one<{ ok: boolean }>(
      "select pg_try_advisory_xact_lock(hashtextextended('platform.events.processing:' || $1, 0)) as ok",
      [environmentId],
    );
    if (!lock?.ok) return null;
    const rows = await db.query<EventRow & { processing_attempts: number }>(
      `select id, organization_id, app_id, environment_id, type, event_name, "timestamp", anonymous_id, user_id, session_id,
              platform, app_version, source, properties, user_properties, context, processing_attempts
         from platform.events
        where processed_at is null and environment_id = $1
        order by id
        limit $2
        for update skip locked`,
      [environmentId, size],
    );
    const plans = new Map<string, PublishedPlan | null>();
    let processed = 0;
    let failed = 0;
    for (const e of rows) {
      if (!plans.has(e.app_id)) plans.set(e.app_id, await loadPublishedPlan(db, e.app_id));
      // A savepoint per event: one bad event never blocks the rest of the batch.
      await db.query("savepoint ev");
      try {
        await processOne(db, e, plans.get(e.app_id) ?? null);
        await db.query("release savepoint ev");
        processed++;
      } catch (err) {
        await db.query("rollback to savepoint ev");
        const message = String((err as Error).message).slice(0, 500);
        if (TRANSIENT.has((err as { code?: string }).code ?? "") && e.processing_attempts + 1 < MAX_PROCESSING_ATTEMPTS) {
          // Left unprocessed: the next batch (or the next worker) retries it.
          await db.query("update platform.events set processing_attempts = processing_attempts + 1, processing_error = $2 where id = $1", [e.id, message]);
        } else {
          failed++;
          await db.query(
            "update platform.events set processed_at = now(), processing_attempts = processing_attempts + 1, processing_error = $2 where id = $1",
            [e.id, message],
          );
        }
      }
    }
    return { claimed: rows.length, processed, failed };
  });
}

async function processOne(db: Db, e: EventRow, plan: PublishedPlan | null) {
  const scope = [e.organization_id, e.app_id, e.environment_id];
  const attribution = (e.context.attribution ?? {}) as Record<string, string>;

  // 1. Identity
  if (e.anonymous_id) {
    await db.query(
      `insert into platform.anonymous_users (organization_id, app_id, environment_id, anonymous_id, device_id, platform, first_seen_at, last_seen_at, first_context)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $8)
       on conflict (environment_id, anonymous_id) do update set
         first_seen_at = least(platform.anonymous_users.first_seen_at, excluded.first_seen_at),
         last_seen_at = greatest(platform.anonymous_users.last_seen_at, excluded.last_seen_at),
         device_id = coalesce(platform.anonymous_users.device_id, excluded.device_id)`,
      [...scope, e.anonymous_id, ((e.context.device ?? {}) as { id?: string }).id ?? null, e.platform, e.timestamp,
       JSON.stringify({ attribution, platform: e.platform, app_version: e.app_version, locale: e.context.locale ?? null })],
    );
  }
  if (e.user_id) {
    const traits = e.type === "identify" && e.user_properties ? e.user_properties : {};
    await db.query(
      `insert into platform.app_users (organization_id, app_id, environment_id, external_id, properties, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $6)
       on conflict (environment_id, external_id) do update set
         properties = platform.app_users.properties || excluded.properties,
         first_seen_at = least(platform.app_users.first_seen_at, excluded.first_seen_at),
         last_seen_at = greatest(platform.app_users.last_seen_at, excluded.last_seen_at)`,
      [...scope, e.user_id, JSON.stringify(traits), e.timestamp],
    );
    if (e.anonymous_id) {
      await db.query(
        `insert into platform.identity_links (organization_id, app_id, environment_id, anonymous_id, user_id, device_id, first_linked_at, last_seen_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)
         on conflict (environment_id, anonymous_id, user_id) do update set
           last_seen_at = greatest(platform.identity_links.last_seen_at, excluded.last_seen_at),
           first_linked_at = least(platform.identity_links.first_linked_at, excluded.first_linked_at)`,
        [...scope, e.anonymous_id, e.user_id, ((e.context.device ?? {}) as { id?: string }).id ?? null, e.timestamp],
      );
    }
  } else if (e.type === "identify" && e.user_properties && e.anonymous_id) {
    // Anonymous traits: kept on the anonymous profile until the user is identified.
    await db.query(
      `update platform.anonymous_users set first_context = first_context || jsonb_build_object('traits', coalesce(first_context->'traits', '{}'::jsonb) || $2::jsonb)
        where environment_id = $1 and anonymous_id = $3`,
      [e.environment_id, JSON.stringify(e.user_properties), e.anonymous_id],
    );
  }
  if (e.type === "alias" && typeof e.properties.previous_id === "string" && e.user_id) {
    await db.query(
      `insert into platform.identity_links (organization_id, app_id, environment_id, anonymous_id, user_id, first_linked_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $6) on conflict (environment_id, anonymous_id, user_id) do nothing`,
      [...scope, `user:${e.properties.previous_id}`, e.user_id, e.timestamp],
    );
  }

  // 2. Sessions
  if (e.session_id) {
    await db.query(
      `insert into platform.sessions (organization_id, app_id, environment_id, session_id, anonymous_id, user_id, started_at, ended_at,
                                      event_count, screen_count, platform, app_version, entry_source, entry_campaign)
       values ($1, $2, $3, $4, $5, $6, $7, $7, 1, $8, $9, $10, $11, $12)
       on conflict (environment_id, session_id) do update set
         started_at = least(platform.sessions.started_at, excluded.started_at),
         ended_at = greatest(platform.sessions.ended_at, excluded.ended_at),
         event_count = platform.sessions.event_count + 1,
         screen_count = platform.sessions.screen_count + excluded.screen_count,
         user_id = coalesce(excluded.user_id, platform.sessions.user_id),
         entry_source = coalesce(platform.sessions.entry_source, excluded.entry_source),
         entry_campaign = coalesce(platform.sessions.entry_campaign, excluded.entry_campaign)`,
      [...scope, e.session_id, e.anonymous_id, e.user_id, e.timestamp, e.type === "screen" ? 1 : 0, e.platform, e.app_version,
       attribution.utm_source ?? attribution.source ?? null, attribution.utm_campaign ?? attribution.campaign ?? null],
    );
  }

  // 3. Push tokens (the raw token is moved out of the event row once stored).
  const push = e.context.push as { token?: string; provider?: string; permission?: string } | undefined;
  if (e.type === "push_token" && push?.token) {
    await db.query(
      `insert into platform.push_tokens (organization_id, app_id, environment_id, token, provider, anonymous_id, user_id, platform, permission_state, status, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $9 = 'denied' then 'opted_out' else 'active' end, $10)
       on conflict (environment_id, token) do update set
         anonymous_id = excluded.anonymous_id, user_id = coalesce(excluded.user_id, platform.push_tokens.user_id),
         permission_state = excluded.permission_state, status = excluded.status, last_seen_at = excluded.last_seen_at`,
      [...scope, push.token, push.provider, e.anonymous_id, e.user_id, e.platform, push.permission ?? "unknown", e.timestamp],
    );
    await db.query(
      "update platform.events set context = jsonb_set(context, '{push}', jsonb_build_object('provider', $2::text, 'permission', $3::text)) where id = $1",
      [e.id, push.provider ?? null, push.permission ?? null],
    );
  }

  // 4. Plan
  const canonical = await applyPlan(db, e, plan);
  await db.query("update platform.events set processed_at = now(), processing_error = null, canonical_name = $2 where id = $1", [
    e.id,
    canonical !== e.event_name ? canonical : null,
  ]);
}

/**
 * Validates one event against the published plan and updates implementation
 * status. Returns the canonical event name.
 */
async function applyPlan(db: Db, e: EventRow, plan: PublishedPlan | null): Promise<string> {
  const canonical = plan?.mappings.get(e.event_name) ?? e.event_name;
  const spec = plan?.specs.get(canonical);
  let valid: boolean | null = null;
  if (spec) {
    const result = validateEvent(spec, { properties: e.properties, user_id: e.user_id, user_properties: e.user_properties });
    valid = result.valid;
    if (!result.valid) {
      await db.query(
        `insert into platform.tracking_validation_results (organization_id, environment_id, event_row_id, event_name, plan_version_id, valid, errors)
         values ($1, $2, $3, $4, $5, false, $6)`,
        [e.organization_id, e.environment_id, e.id, canonical, plan!.versionId, JSON.stringify(result.errors)],
      );
    }
  }
  await db.query(
    `insert into platform.tracking_implementation_status
       (organization_id, app_id, environment_id, event_name, status, first_received_at, last_received_at, received_count, valid_count, invalid_count, last_sources)
     values ($1, $2, $3, $4, $5, $6, $6, 1, $7, $8, array[$9])
     on conflict (environment_id, event_name) do update set
       status = case when platform.tracking_implementation_status.status = 'deprecated' then 'deprecated'
                     when platform.tracking_implementation_status.valid_count + excluded.valid_count > 0 then 'validated'
                     else 'received' end,
       first_received_at = least(platform.tracking_implementation_status.first_received_at, excluded.first_received_at),
       last_received_at = greatest(platform.tracking_implementation_status.last_received_at, excluded.last_received_at),
       received_count = platform.tracking_implementation_status.received_count + 1,
       valid_count = platform.tracking_implementation_status.valid_count + excluded.valid_count,
       invalid_count = platform.tracking_implementation_status.invalid_count + excluded.invalid_count,
       last_sources = (select array(select distinct unnest(platform.tracking_implementation_status.last_sources || excluded.last_sources))),
       updated_at = now()`,
    [e.organization_id, e.app_id, e.environment_id, canonical, valid ? "validated" : "received", e.timestamp,
     valid ? 1 : 0, valid === false ? 1 : 0, e.source],
  );
  if (plan && plan.specs.size && !spec && !SYSTEM_NAMES.has(e.event_name)) {
    const s = suggestMapping(e.event_name, [...plan.specs.keys()]);
    if (s) {
      await db.query(
        `insert into platform.event_mappings (organization_id, app_id, from_name, to_name, similarity)
         values ($1, $2, $3, $4, $5) on conflict (app_id, from_name) do nothing`,
        [e.organization_id, e.app_id, e.event_name, s.to, s.score],
      );
    }
  }
  return canonical;
}

/**
 * Re-derives what depends on the plan and mappings after they change (publish,
 * mapping accepted), in a handful of set-based statements so it fits in the
 * request that made the change:
 *   - status rows received under a now-mapped name are merged into the
 *     canonical name; lifetime counters (received_count, first/last received,
 *     sources) are never reset;
 *   - recent events (bounded window) get their canonical name, validation
 *     results and valid/invalid counts re-evaluated against the new plan;
 *     rows with no recent events keep their counts;
 *   - status is re-derived from the counts, and deprecated where needed.
 * Identity and sessions are untouched (they never depend on the plan). Holds
 * the app's processing locks so it never races the event processor.
 */
export async function recomputeImplementation(db: Db, appId: string, opts: { days?: number; maxEvents?: number } = {}): Promise<number> {
  await db.query(
    "select pg_advisory_xact_lock(hashtextextended('platform.events.processing:' || id::text, 0)) from platform.environments where app_id = $1 order by id",
    [appId],
  );
  const plan = await loadPublishedPlan(db, appId);

  // 1. Merge status rows of mapped names into their canonical name.
  await db.query(
    `with moved as (
       delete from platform.tracking_implementation_status s
        using platform.event_mappings m
        where m.app_id = $1 and m.status = 'accepted' and m.from_name <> m.to_name
          and s.app_id = $1 and s.event_name = m.from_name
       returning s.organization_id, s.app_id, s.environment_id, m.to_name, s.first_received_at, s.last_received_at,
                 s.received_count, s.valid_count, s.invalid_count, s.last_sources)
     insert into platform.tracking_implementation_status as t
       (organization_id, app_id, environment_id, event_name, status, first_received_at, last_received_at, received_count, valid_count, invalid_count, last_sources)
     select organization_id, app_id, environment_id, to_name, 'received', min(first_received_at), max(last_received_at),
            sum(received_count), sum(valid_count), sum(invalid_count),
            array(select distinct x from moved m2, unnest(m2.last_sources) x where m2.environment_id = moved.environment_id and m2.to_name = moved.to_name)
       from moved group by organization_id, app_id, environment_id, to_name
     on conflict (environment_id, event_name) do update set
       first_received_at = least(t.first_received_at, excluded.first_received_at),
       last_received_at = greatest(t.last_received_at, excluded.last_received_at),
       received_count = t.received_count + excluded.received_count,
       valid_count = t.valid_count + excluded.valid_count,
       invalid_count = t.invalid_count + excluded.invalid_count,
       last_sources = (select array(select distinct unnest(t.last_sources || excluded.last_sources))),
       updated_at = now()`,
    [appId],
  );

  // 2. Re-validate the recent window in memory.
  const rows = await db.query<Pick<EventRow, "id" | "organization_id" | "environment_id" | "event_name" | "user_id" | "properties" | "user_properties">>(
    `select id, organization_id, environment_id, event_name, user_id, properties, user_properties
       from platform.events
      where app_id = $1 and processed_at is not null and received_at > now() - make_interval(days => $2)
      order by id desc limit $3`,
    [appId, opts.days ?? 30, opts.maxEvents ?? 5000],
  );
  const ids: string[] = [];
  const canonicals: (string | null)[] = [];
  const invalid: { organization_id: string; environment_id: string; event_row_id: string; event_name: string; errors: unknown }[] = [];
  const counts = new Map<string, { environment_id: string; event_name: string; valid: number; invalid: number }>();
  for (const e of rows) {
    const canonical = plan?.mappings.get(e.event_name) ?? e.event_name;
    ids.push(e.id);
    canonicals.push(canonical !== e.event_name ? canonical : null);
    const key = `${e.environment_id}:${canonical}`;
    if (!counts.has(key)) counts.set(key, { environment_id: e.environment_id, event_name: canonical, valid: 0, invalid: 0 });
    const spec = plan?.specs.get(canonical);
    if (!spec) continue;
    const result = validateEvent(spec, { properties: e.properties, user_id: e.user_id, user_properties: e.user_properties });
    if (result.valid) counts.get(key)!.valid++;
    else {
      counts.get(key)!.invalid++;
      invalid.push({ organization_id: e.organization_id, environment_id: e.environment_id, event_row_id: e.id, event_name: canonical, errors: result.errors });
    }
  }
  await db.query(
    `update platform.events e set canonical_name = v.c
       from unnest($1::bigint[], $2::text[]) as v(id, c)
      where e.id = v.id and e.canonical_name is distinct from v.c`,
    [ids, canonicals],
  );
  // Results from an older plan version, or for the events re-validated here, are replaced.
  await db.query(
    `delete from platform.tracking_validation_results
      where environment_id in (select id from platform.environments where app_id = $1)
        and (plan_version_id is distinct from $2 or event_row_id = any($3::bigint[]))`,
    [appId, plan?.versionId || null, ids],
  );
  if (invalid.length && plan) {
    await db.query(
      `insert into platform.tracking_validation_results (organization_id, environment_id, event_row_id, event_name, plan_version_id, valid, errors)
       select v.organization_id, v.environment_id, v.event_row_id, v.event_name, $2, false, v.errors
         from jsonb_to_recordset($1) as v(organization_id uuid, environment_id uuid, event_row_id bigint, event_name text, errors jsonb)`,
      [JSON.stringify(invalid), plan.versionId],
    );
  }
  await db.query(
    `update platform.tracking_implementation_status s set valid_count = v.valid, invalid_count = v.invalid, updated_at = now()
       from jsonb_to_recordset($2) as v(environment_id uuid, event_name text, valid bigint, invalid bigint)
      where s.app_id = $1 and s.environment_id = v.environment_id and s.event_name = v.event_name`,
    [appId, JSON.stringify([...counts.values()])],
  );

  // 3. Status from the counts; received events the new plan no longer contains are deprecated.
  await db.query(
    "update platform.tracking_implementation_status set status = case when valid_count > 0 then 'validated' else 'received' end where app_id = $1",
    [appId],
  );
  if (plan?.versionId) {
    await db.query(
      `update platform.tracking_implementation_status s set status = 'deprecated'
        where s.app_id = $1 and not exists (select 1 from platform.tracking_events t where t.plan_version_id = $2 and t.event_name = s.event_name)
          and exists (select 1 from platform.tracking_plan_versions v
                        join platform.tracking_events t2 on t2.plan_version_id = v.id
                       where v.tracking_plan_id = (select tracking_plan_id from platform.tracking_plan_versions where id = $2)
                         and v.id <> $2 and t2.event_name = s.event_name)`,
      [appId, plan.versionId],
    );
  }
  return rows.length;
}
