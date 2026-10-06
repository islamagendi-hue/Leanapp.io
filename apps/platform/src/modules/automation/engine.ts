import "server-only";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { PERSON } from "@/modules/analytics/service";
import { personMatches } from "@/modules/audiences/service";
import { messagingBlocked, splitUserKey } from "@/modules/messaging/consent";
import { loadDeliveryCredentials, markIntegration, sendCustomerEmail, type DeliveryCredentials } from "@/modules/messaging/integrations";
import type { PushContent } from "@/modules/push/messages";
import { sendApns, sendFcm, type PushOutcome } from "@/modules/push/transport";
import { recordUsage } from "@/modules/usage/service";
import { enqueueDelivery } from "@/modules/webhooks/service";
import { MESSAGE_STEPS, parseAutomation, renderTemplate, type AutomationDefinition, type Step } from "./definition";
import type { RunLogEntry } from "./service";
import { nextScheduled, quietHoursEnd } from "./time";

/**
 * The automation engine, driven by the scheduled worker:
 *
 *  1. enqueueTriggers(): for each active automation (row-locked with SKIP
 *     LOCKED), turns new trigger occurrences after its cursor into runs:
 *     events (processed, track, not sent by an automation, ≤ 24 h old),
 *     audience transitions (not the initial baseline), or a schedule slot for
 *     everyone in an audience. Entry rules: one run in progress per person,
 *     "once" or a cooldown; idempotent per (automation, person, trigger).
 *  2. stepRuns(): claims due runs (FOR UPDATE SKIP LOCKED, a lease on
 *     next_run_at) and executes steps until a delay, quiet hours, an exit or
 *     the end. Each run executes in its own transaction under the
 *     organization's RLS scope, and every step leaves a log entry.
 *
 * Guardrails: per-person frequency cap over messages from all automations of
 * the environment; quiet hours in the organization's timezone for push and
 * email (the run waits, then sends); consent opt-outs; pending deletions.
 */

const EVENT_BATCH = 1000;
const MAX_EVENT_AGE_HOURS = 24;
const MAX_STEPS_PER_CLAIM = 50;
const LEASE_MINUTES = 5;
const MAX_RUN_ATTEMPTS = 3;
const MAX_LOG_ENTRIES = 200;

// ── 1. Triggers ─────────────────────────────────────────────────────────────
interface AutomationClaim {
  id: string;
  organization_id: string;
  environment_id: string;
  version: number;
  definition: AutomationDefinition;
  trigger_cursor: string | null;
  next_fire_at: Date | null;
  timezone: string;
}

/** Inserts runs for candidate (person, trigger_key, trigger_data, sort) rows produced by `candidatesSql`, applying entry rules. */
async function insertRuns(db: Db, a: AutomationClaim, candidatesSql: string, params: unknown[]): Promise<number> {
  const n = params.length;
  const rows = await db.query(
    `with candidates as (${candidatesSql}),
     firsts as (select distinct on (person) * from candidates where person is not null order by person, sort)
     insert into platform.automation_runs (organization_id, automation_id, environment_id, user_key, status, current_step, next_run_at, version, trigger_key, trigger_data, log)
     select $${n + 1}, $${n + 2}, $${n + 3}, c.person, 'pending', 0, now(), $${n + 4}, c.trigger_key, c.trigger_data,
            jsonb_build_array(jsonb_build_object('at', now(), 'step', null, 'type', 'trigger', 'outcome', 'started', 'detail', c.trigger_key))
       from firsts c
      where not exists (
              select 1 from platform.automation_runs r
               where r.automation_id = $${n + 2} and r.user_key = c.person
                 and (r.status in ('pending', 'waiting', 'running') or $${n + 5} or r.started_at > now() - make_interval(hours => $${n + 6})))
        and not exists (
              select 1 from platform.privacy_requests pr
               where pr.environment_id = $${n + 3} and pr.kind = 'deletion' and pr.status in ('received', 'processing')
                 and (pr.subject_user_id = c.person or 'anon:' || pr.subject_anonymous_id = c.person))
     on conflict (automation_id, user_key, trigger_key) where trigger_key is not null do nothing
     returning 1`,
    [...params, a.organization_id, a.id, a.environment_id, a.version, a.definition.entry.mode === "once", a.definition.entry.cooldownHours],
  );
  if (rows.length) await recordUsage(db, a.organization_id, "automation_runs", rows.length);
  return rows.length;
}

async function triggerOne(db: Db, a: AutomationClaim): Promise<number> {
  const t = a.definition.trigger;
  if (t.type === "event") {
    // Never pass an unprocessed event: canonical names are only final once processed.
    const bound = await db.one<{ bound: string }>(
      `select coalesce((select min(id) from platform.events where environment_id = $1 and processed_at is null),
                       (select max(id) + 1 from platform.events where environment_id = $1), 0) as bound`,
      [a.environment_id],
    );
    const from = a.trigger_cursor ?? "0";
    const last = await db.one<{ id: string | null; n: string }>(
      `select max(id) as id, count(*) as n from (
         select e.id from platform.events e
          where e.environment_id = $1 and e.id > $2 and e.id < $3 and e.type = 'track'
            and coalesce(e.canonical_name, e.event_name) = $4
          order by e.id limit $5) x`,
      [a.environment_id, from, bound!.bound, t.event, EVENT_BATCH],
    );
    const upTo = Number(last!.n) >= EVENT_BATCH ? last!.id! : String(Math.max(Number(from), Number(bound!.bound) - 1));
    const created = Number(last!.n)
      ? await insertRuns(
          db, a,
          `select ${PERSON.expr} as person, 'event:' || e.id as trigger_key, e.id as sort,
                  jsonb_build_object('event', coalesce(e.canonical_name, e.event_name), 'event_row_id', e.id, 'timestamp', e."timestamp", 'properties', e.properties) as trigger_data
             from platform.events e ${PERSON.join}
            where e.environment_id = $1 and e.id > $2 and e.id <= $3 and e.type = 'track'
              and coalesce(e.canonical_name, e.event_name) = $4
              and e."timestamp" > now() - make_interval(hours => $5)
              and coalesce(e.user_id, e.anonymous_id) is not null
              and not (e.context ? 'automation')`,
          [a.environment_id, from, upTo, t.event, MAX_EVENT_AGE_HOURS],
        )
      : 0;
    await db.query("update platform.automations set trigger_cursor = $2 where id = $1", [a.id, upTo]);
    return created;
  }
  if (t.type === "audience_entered" || t.type === "audience_exited") {
    const kind = t.type === "audience_entered" ? "entered" : "exited";
    const last = await db.one<{ id: string | null }>(
      `select max(id) as id from (select id from platform.audience_events where audience_id = $1 and id > $2 order by id limit $3) x`,
      [t.audienceId, a.trigger_cursor ?? "0", EVENT_BATCH],
    );
    if (!last?.id) return 0;
    const created = await insertRuns(
      db, a,
      `select ae.user_key as person, 'audience:' || ae.id as trigger_key, ae.id as sort,
              jsonb_build_object('audience_id', ae.audience_id, 'kind', ae.kind, 'occurred_at', ae.occurred_at) as trigger_data
         from platform.audience_events ae
        where ae.audience_id = $1 and ae.id > $2 and ae.id <= $3 and ae.kind = $4 and not ae.initial`,
      [t.audienceId, a.trigger_cursor ?? "0", last.id, kind],
    );
    await db.query("update platform.automations set trigger_cursor = $2 where id = $1", [a.id, last.id]);
    return created;
  }
  // Schedule: everyone currently in the audience, once per slot.
  if (!a.next_fire_at || a.next_fire_at.getTime() > Date.now()) return 0;
  const slot = a.next_fire_at.toISOString();
  const created = await insertRuns(
    db, a,
    `select m.user_key as person, 'schedule:' || $2 as trigger_key, 0 as sort, jsonb_build_object('scheduled_for', $2::text) as trigger_data
       from platform.audience_members m join platform.audiences au on au.id = m.audience_id and au.status = 'active'
      where m.audience_id = $1 and m.exited_at is null`,
    [t.audienceId, slot],
  );
  await db.query("update platform.automations set next_fire_at = $2 where id = $1", [a.id, nextScheduled(new Date(), a.timezone, t)]);
  return created;
}

/** Turns new trigger occurrences of active automations into runs. Bounded per automation; safe to run concurrently. */
export async function enqueueTriggers(opts: { deadline?: number; automationIds?: string[] } = {}): Promise<{ automations: number; runs: number }> {
  const ids = await withSystem((db) =>
    db.query<{ id: string; organization_id: string }>(
      "select id, organization_id from platform.automations where status = 'active' and ($1::uuid[] is null or id = any($1)) order by updated_at",
      [opts.automationIds ?? null],
    ),
  );
  let runs = 0;
  let automations = 0;
  for (const { id, organization_id } of ids) {
    if (opts.deadline && Date.now() >= opts.deadline) break;
    try {
      runs += await withTenant({ organizationId: organization_id, userId: null }, async (db) => {
        const a = await db.one<AutomationClaim>(
          `select a.id, a.organization_id, a.environment_id, a.version, a.definition, a.trigger_cursor::text as trigger_cursor, a.next_fire_at, o.timezone
             from platform.automations a join platform.organizations o on o.id = a.organization_id
            where a.id = $1 and a.status = 'active' for update of a skip locked`,
          [id],
        );
        if (!a) return 0;
        automations++;
        return triggerOne(db, { ...a, definition: parseAutomation(a.definition) });
      });
    } catch (err) {
      log.error("automation.trigger_failed", { automation_id: id, organization_id, error: err });
    }
  }
  return { automations, runs };
}

// ── 2. Stepping ─────────────────────────────────────────────────────────────
interface RunClaim {
  id: string;
  organization_id: string;
  automation_id: string;
  environment_id: string;
  user_key: string;
  current_step: number;
  version: number;
  trigger_data: Record<string, unknown>;
  started_at: Date;
  attempts: number;
}

/** Claims and executes due runs. Returns how many runs were stepped. */
export async function stepRuns(opts: { limit?: number; deadline?: number; runIds?: string[]; now?: () => Date } = {}): Promise<{ stepped: number; failed: number }> {
  const claimed = await withSystem((db) =>
    db.query<RunClaim>(
      `update platform.automation_runs r set status = 'running', next_run_at = now() + make_interval(mins => $3), attempts = r.attempts + 1, updated_at = now()
        where r.id in (
          select r2.id from platform.automation_runs r2 join platform.automations a on a.id = r2.automation_id
           where r2.status in ('pending', 'waiting', 'running') and r2.next_run_at <= now() and a.status = 'active'
             and ($2::uuid[] is null or r2.id = any($2))
           order by r2.next_run_at limit $1
           for update of r2 skip locked)
        returning r.id, r.organization_id, r.automation_id, coalesce(r.environment_id, (select environment_id from platform.automations where id = r.automation_id)) as environment_id,
                  r.user_key, r.current_step, r.version, r.trigger_data, r.started_at, r.attempts`,
      [opts.limit ?? 200, opts.runIds ?? null, LEASE_MINUTES],
    ),
  );
  let stepped = 0;
  let failed = 0;
  const credentials = new Map<string, DeliveryCredentials>();
  for (const run of claimed) {
    if (opts.deadline && Date.now() >= opts.deadline) {
      await withSystem((db) => db.query("update platform.automation_runs set status = 'pending', next_run_at = now(), attempts = attempts - 1 where id = $1", [run.id]));
      continue;
    }
    try {
      await withTenant({ organizationId: run.organization_id, userId: null }, async (db) => {
        if (!credentials.has(run.environment_id)) credentials.set(run.environment_id, await loadDeliveryCredentials(db, run.environment_id));
        await executeRun(db, run, credentials.get(run.environment_id)!, opts.now ?? (() => new Date()));
      });
      stepped++;
    } catch (err) {
      failed++;
      log.error("automation.run_failed", { run_id: run.id, automation_id: run.automation_id, attempt: run.attempts, error: err });
      const final = run.attempts >= MAX_RUN_ATTEMPTS;
      await withSystem((db) =>
        db.query(
          `update platform.automation_runs set status = $2, last_error = 'internal_error', next_run_at = case when $2 = 'failed' then null else now() + interval '5 minutes' end,
                  finished_at = case when $2 = 'failed' then now() end,
                  log = log || jsonb_build_array(jsonb_build_object('at', now(), 'step', current_step, 'type', 'run', 'outcome', 'failed', 'detail', $3::text))
            where id = $1`,
          [run.id, final ? "failed" : "pending", final ? "Internal error; gave up after 3 attempts." : "Internal error; will retry."],
        ),
      );
    }
  }
  return { stepped, failed };
}

type StepResult =
  | { next: "continue"; entry: Omit<RunLogEntry, "at" | "step"> }
  | { next: "goto"; to: number; entry: Omit<RunLogEntry, "at" | "step"> }
  | { next: "wait"; until: Date; advance: boolean; entry: Omit<RunLogEntry, "at" | "step"> }
  | { next: "exit"; entry: Omit<RunLogEntry, "at" | "step"> };

interface RunEnv {
  db: Db;
  run: RunClaim;
  automation: { name: string; definition: AutomationDefinition; status: string };
  timezone: string;
  creds: DeliveryCredentials;
  now: () => Date;
  profile: Record<string, unknown>;
}

async function executeRun(db: Db, run: RunClaim, creds: DeliveryCredentials, now: () => Date) {
  const meta = await db.one<{ name: string; status: string; definition: AutomationDefinition; timezone: string }>(
    `select a.name, a.status, v.definition, o.timezone
       from platform.automations a
       join platform.automation_versions v on v.automation_id = a.id and v.version = $2
       join platform.organizations o on o.id = a.organization_id
      where a.id = $1`,
    [run.automation_id, run.version],
  );
  if (!meta) throw new Error("automation version missing");
  const definition = parseAutomation(meta.definition);
  const { userId, anonymousId } = splitUserKey(run.user_key);
  const profile = userId
    ? (await db.one<{ properties: Record<string, unknown> }>("select properties from platform.app_users where environment_id = $1 and external_id = $2", [run.environment_id, userId]))?.properties ?? {}
    : (await db.one<{ traits: Record<string, unknown> }>("select coalesce(first_context->'traits', '{}') as traits from platform.anonymous_users where environment_id = $1 and anonymous_id = $2", [run.environment_id, anonymousId]))?.traits ?? {};
  const env: RunEnv = { db, run, automation: { ...meta, definition }, timezone: meta.timezone, creds, now, profile };

  const entries: RunLogEntry[] = [];
  let step = run.current_step;
  let status: "completed" | "waiting" | "pending" | "cancelled" = "completed";
  let nextRunAt: Date | null = null;

  const deleting = await db.one(
    `select 1 from platform.privacy_requests where environment_id = $1 and kind = 'deletion' and status in ('received', 'processing') and (subject_user_id = $2 or subject_anonymous_id = $3)`,
    [run.environment_id, userId, anonymousId],
  );
  if (deleting) {
    status = "cancelled";
    entries.push({ at: now().toISOString(), step, type: "run", outcome: "cancelled", detail: "A data deletion request is pending for this person." });
  } else {
    for (let i = 0; i < MAX_STEPS_PER_CLAIM; i++) {
      if (step >= definition.steps.length) break;
      const s = definition.steps[step];
      const r = await executeStep(env, s, step);
      entries.push({ at: now().toISOString(), step, ...r.entry });
      if (r.next === "continue") step++;
      else if (r.next === "goto") step = r.to;
      else if (r.next === "exit") {
        step = definition.steps.length;
        break;
      } else {
        if (r.advance) step++;
        status = "waiting";
        nextRunAt = r.until;
        break;
      }
      if (i === MAX_STEPS_PER_CLAIM - 1 && step < definition.steps.length) {
        status = "pending";
        nextRunAt = now();
      }
    }
    if (status === "completed") entries.push({ at: now().toISOString(), step: null, type: "run", outcome: "completed" });
  }
  await db.query(
    `update platform.automation_runs
        set status = $2, current_step = $3, next_run_at = $4, attempts = 0, last_error = null,
            finished_at = case when $2 in ('completed', 'cancelled') then now() end,
            log = (select coalesce(jsonb_agg(x order by n), '[]') from (
                     select x, n from jsonb_array_elements(log || $5::jsonb) with ordinality t(x, n)
                     order by n desc limit ${MAX_LOG_ENTRIES}) last)
      where id = $1`,
    [run.id, status, step, nextRunAt, JSON.stringify(entries)],
  );
}

const PROVIDER_LABEL = { fcm: "FCM", apns: "APNs" } as const;

async function executeStep(env: RunEnv, s: Step, index: number): Promise<StepResult> {
  const { db, run, automation, now } = env;
  const def = automation.definition;
  const { userId, anonymousId } = splitUserKey(run.user_key);
  const vars = { user: env.profile, event: (run.trigger_data.properties ?? {}) as Record<string, unknown> };

  if (MESSAGE_STEPS.has(s.type)) {
    // Quiet hours first (the run waits and retries this step), then the frequency cap at send time.
    if (def.quietHours && s.type !== "in_app") {
      const until = quietHoursEnd(now(), env.timezone, def.quietHours);
      if (until) return { next: "wait", until, advance: false, entry: { type: s.type, outcome: "waiting", detail: `Quiet hours (${def.quietHours.start}–${def.quietHours.end} ${env.timezone}); sending at ${until.toISOString()}` } };
    }
    if (def.frequencyCap) {
      const sent = await db.one<{ n: string }>(
        `select (select count(*) from platform.notifications where environment_id = $1 and user_key = $2 and status in ('sent', 'delivered', 'opened') and created_at > now() - make_interval(hours => $3))
              + (select count(*) from platform.in_app_messages where environment_id = $1 and user_key = $2 and created_at > now() - make_interval(hours => $3)) as n`,
        [run.environment_id, run.user_key, def.frequencyCap.hours],
      );
      if (Number(sent!.n) >= def.frequencyCap.messages) {
        return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: `Frequency cap: ${sent!.n} messages in the last ${def.frequencyCap.hours} h (limit ${def.frequencyCap.messages}).` } };
      }
    }
  }

  switch (s.type) {
    case "delay": {
      const ms = s.amount * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[s.unit];
      const until = new Date(now().getTime() + ms);
      return { next: "wait", until, advance: true, entry: { type: "delay", outcome: "waiting", detail: `Until ${until.toISOString()}` } };
    }
    case "branch": {
      const ok = await personMatches(db, run.environment_id, run.user_key, s.condition, triggerTime(run));
      if (ok) return { next: "continue", entry: { type: "branch", outcome: "done", detail: "Condition met" } };
      if (s.else === "exit") return { next: "exit", entry: { type: "branch", outcome: "exit", detail: "Condition not met: run ends" } };
      return { next: "goto", to: s.else.goto, entry: { type: "branch", outcome: "done", detail: `Condition not met: going to step ${s.else.goto + 1}` } };
    }
    case "webhook": {
      const w = await db.one<{ status: string }>("select status from platform.webhooks where id = $1 and environment_id = $2", [s.webhookId, run.environment_id]);
      if (!w || w.status !== "active") return { next: "continue", entry: { type: "webhook", outcome: "failed", detail: w ? "Webhook is disabled" : "Webhook no longer exists" } };
      const id = await enqueueDelivery(db, {
        organizationId: run.organization_id, environmentId: run.environment_id, webhookId: s.webhookId, eventType: "automation.webhook",
        idempotencyKey: `run:${run.id}:${index}`, automationRunId: run.id,
        data: { automation: { id: run.automation_id, name: automation.name, version: run.version }, run_id: run.id, step: index, user_key: run.user_key, user_id: userId, anonymous_id: anonymousId, trigger: run.trigger_data },
      });
      return { next: "continue", entry: { type: "webhook", outcome: "done", detail: id ? `Delivery ${id} queued` : "Already queued" } };
    }
    case "push":
      return sendPush(env, s, index, vars);
    case "email":
      return sendEmailStep(env, s, index, vars);
    case "in_app": {
      const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "in_app");
      if (blocked) return { next: "continue", entry: { type: "in_app", outcome: "skipped", detail: `Not sent: ${blocked}` } };
      const appId = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [run.environment_id]);
      const row = await db.one(
        `insert into platform.in_app_messages (organization_id, app_id, environment_id, user_key, automation_id, automation_run_id, step, title, body, button_text, deep_link, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(hours => $12))
         on conflict (automation_run_id, step) do nothing returning id`,
        [run.organization_id, appId!.app_id, run.environment_id, run.user_key, run.automation_id, run.id, index,
         renderTemplate(s.title, vars), renderTemplate(s.body, vars), s.buttonText ?? null, s.deepLink ?? null, s.expiresInHours],
      );
      return { next: "continue", entry: { type: "in_app", outcome: "done", detail: row ? `Queued for the app (expires in ${s.expiresInHours} h)` : "Already queued" } };
    }
    case "update_user_property": {
      const value = JSON.stringify(s.value);
      const updated = userId
        ? await db.query("update platform.app_users set properties = properties || jsonb_build_object($3::text, $4::jsonb) where environment_id = $1 and external_id = $2 returning 1", [run.environment_id, userId, s.property, value])
        : await db.query(
            `update platform.anonymous_users set first_context = first_context || jsonb_build_object('traits', coalesce(first_context->'traits', '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb))
              where environment_id = $1 and anonymous_id = $2 returning 1`,
            [run.environment_id, anonymousId, s.property, value],
          );
      if (!updated.length) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: "No profile for this person" } };
      env.profile = { ...env.profile, [s.property]: s.value };
      return { next: "continue", entry: { type: s.type, outcome: "done", detail: `${s.property} = ${value}` } };
    }
    case "send_event": {
      const ids = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [run.environment_id]);
      const row = await db.one(
        `insert into platform.events (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", anonymous_id, user_id, source, properties, context)
         values ($1, $2, $3, $4, 'track', $5, now(), $6, $7, 'automatic', $8, $9)
         on conflict (environment_id, event_id) do nothing returning id`,
        [run.organization_id, ids!.app_id, run.environment_id, `automation:${run.id}:${index}`, s.event, anonymousId, userId,
         JSON.stringify(s.properties), JSON.stringify({ automation: { id: run.automation_id, run_id: run.id } })],
      );
      if (row) await recordUsage(db, run.organization_id, "events", 1);
      return { next: "continue", entry: { type: s.type, outcome: "done", detail: row ? `Sent ${s.event}` : "Already sent" } };
    }
  }
}

/** When the trigger happened (event time, audience change, schedule slot), not when the worker picked it up. */
export function triggerTime(run: Pick<RunClaim, "trigger_data" | "started_at">): Date {
  const d = run.trigger_data;
  const at = d.timestamp ?? d.occurred_at ?? d.scheduled_for;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? new Date(run.started_at) : new Date(Math.min(t, new Date(run.started_at).getTime()));
}

async function pushTokens(db: Db, environmentId: string, userKey: string) {
  const { userId, anonymousId } = splitUserKey(userKey);
  return db.query<{ id: string; token: string; provider: "fcm" | "apns" }>(
    `select t.id, t.token, t.provider from platform.push_tokens t
      where t.environment_id = $1 and t.status = 'active' and t.permission_state <> 'denied'
        and (($2::text is not null and (t.user_id = $2 or (t.user_id is null and t.anonymous_id in (
                select anonymous_id from platform.identity_links where environment_id = $1 group by anonymous_id having count(*) = 1 and min(user_id) = $2))))
             or ($3::text is not null and t.user_id is null and t.anonymous_id = $3))
      order by t.last_seen_at desc limit 10`,
    [environmentId, userId, anonymousId],
  );
}

async function sendPush(env: RunEnv, s: Extract<Step, { type: "push" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "push");
  if (blocked) return { next: "continue", entry: { type: "push", outcome: "skipped", detail: `Not sent: ${blocked}` } };
  const tokens = await pushTokens(db, run.environment_id, run.user_key);
  if (!tokens.length) return { next: "continue", entry: { type: "push", outcome: "skipped", detail: "No active push token" } };
  const content: PushContent = {
    title: renderTemplate(s.title, vars),
    body: renderTemplate(s.body, vars),
    data: { automation_id: run.automation_id, run_id: run.id, ...(s.deepLink ? { deep_link: s.deepLink } : {}) },
  };
  let sent = 0;
  const problems: string[] = [];
  for (const t of tokens) {
    const notif = await db.one<{ id: string }>(
      `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, automation_run_id, step, push_token_id, status, payload)
       values ($1, $2, 'push', $3, $4, $5, $6, $7, 'queued', $8)
       on conflict (automation_run_id, step, coalesce(push_token_id, '00000000-0000-0000-0000-000000000000'::uuid)) where automation_run_id is not null do nothing
       returning id`,
      [run.organization_id, run.environment_id, t.provider, run.user_key, run.id, index, t.id, JSON.stringify({ title: content.title, body: content.body, data: content.data })],
    );
    if (!notif) continue; // already attempted for this token
    let outcome: PushOutcome;
    let integrationId: string | null = null;
    if (t.provider === "fcm" && creds.fcm) {
      integrationId = creds.fcm.id;
      outcome = await sendFcm(creds.fcm.sa, t.token, content);
    } else if (t.provider === "apns" && creds.apns) {
      integrationId = creds.apns.id;
      outcome = await sendApns(creds.apns.creds, t.token, content);
    } else {
      const why = creds.errors[t.provider] ? `${PROVIDER_LABEL[t.provider]} credentials can't be read` : `${PROVIDER_LABEL[t.provider]} is not connected`;
      outcome = { ok: false, invalidToken: false, status: null, error: why };
    }
    await db.query("update platform.notifications set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end where id = $1", [
      notif.id, outcome.ok ? "sent" : "failed", outcome.error,
    ]);
    if (integrationId) await markIntegration(db, integrationId, outcome.ok || outcome.invalidToken ? null : outcome.error);
    if (outcome.invalidToken) {
      await db.query("update platform.push_tokens set status = 'invalid', invalidated_at = now() where id = $1", [t.id]);
    }
    if (outcome.ok) sent++;
    else problems.push(outcome.invalidToken ? `${t.provider} token invalid (deactivated)` : (outcome.error ?? "failed"));
  }
  if (sent) await recordUsage(db, run.organization_id, "push_messages", sent);
  const detail = [`Sent to ${sent} of ${tokens.length} device${tokens.length === 1 ? "" : "s"}`, ...new Set(problems)].join("; ");
  return { next: "continue", entry: { type: "push", outcome: sent ? "done" : "failed", detail } };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function sendEmailStep(env: RunEnv, s: Extract<Step, { type: "email" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const to = typeof env.profile.email === "string" ? env.profile.email.trim() : "";
  if (!to || !EMAIL.test(to)) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: "No email user property" } };
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "email");
  if (blocked) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: `Not sent: ${blocked}` } };
  const subject = renderTemplate(s.subject, vars);
  const notif = await db.one<{ id: string }>(
    `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, automation_run_id, step, status, payload)
     values ($1, $2, 'email', 'resend', $3, $4, $5, 'queued', $6)
     on conflict (automation_run_id, step, coalesce(push_token_id, '00000000-0000-0000-0000-000000000000'::uuid)) where automation_run_id is not null do nothing
     returning id`,
    [run.organization_id, run.environment_id, run.user_key, run.id, index, JSON.stringify({ subject })],
  );
  if (!notif) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: "Already attempted" } };
  let result: { ok: boolean; error: string | null };
  if (!creds.resend) {
    result = { ok: false, error: creds.errors.resend ? "Email credentials can't be read" : "Email (Resend) is not connected" };
  } else {
    result = await sendCustomerEmail(creds.resend.creds, { to, subject, text: renderTemplate(s.body, vars), tag: run.automation_id });
    await markIntegration(db, creds.resend.id, result.ok ? null : result.error);
  }
  await db.query("update platform.notifications set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end where id = $1", [notif.id, result.ok ? "sent" : "failed", result.error]);
  return { next: "continue", entry: { type: "email", outcome: result.ok ? "done" : "failed", detail: result.ok ? "Sent" : result.error ?? "Failed" } };
}
