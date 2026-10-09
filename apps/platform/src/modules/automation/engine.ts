import "server-only";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { PERSON } from "@/modules/analytics/service";
import { personMatches } from "@/modules/audiences/service";
import { messagingBlocked, splitUserKey } from "@/modules/messaging/consent";
import { deliverEmail, deliverMessage, deliverPush } from "@/modules/messaging/deliver";
import { lastInboundAt } from "@/modules/messaging/inbound";
import { resolveMedia } from "@/modules/messaging/media";
import { HEADER_MEDIA, mmsAllowed } from "@/modules/messaging/providers/media";
import { getEmailTemplate } from "@/modules/messaging/email";
import { loadDeliveryCredentials, type DeliveryCredentials } from "@/modules/messaging/integrations";
import type { PushContent } from "@/modules/push/messages";
import { sessionOpen, toE164 } from "@/modules/whatsapp/messages";
import { findTemplate } from "@/modules/whatsapp/service";
import { recordUsage } from "@/modules/usage/service";
import { enqueueDelivery } from "@/modules/webhooks/service";
import { MESSAGE_STEPS, OUTCOME_LABELS, parseAutomation, renderTemplate, type AutomationDefinition, type Step } from "./definition";
import { fill } from "./messages";
import { RUN_LOG } from "./run-log";
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
 * the environment; quiet hours in the organization's timezone for push,
 * email and WhatsApp (the run waits, then sends); consent and suppression
 * lists; pending deletions.
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
  if (t.type === "inbound_message") {
    // Replies from people we can identify (we messaged that number), never opt-outs.
    const last = await db.one<{ id: string | null }>(
      `select max(id) as id from (select id from platform.inbound_messages where environment_id = $1 and id > $2 order by id limit $3) x`,
      [a.environment_id, a.trigger_cursor ?? "0", EVENT_BATCH],
    );
    if (!last?.id) return 0;
    const created = await insertRuns(
      db, a,
      `select im.user_key as person, 'inbound:' || im.id as trigger_key, im.id as sort,
              jsonb_build_object('channel', im.channel, 'occurred_at', im.received_at, 'message_type', im.message_type,
                                 'properties', jsonb_build_object('text', left(coalesce(im.body, ''), 500), 'channel', im.channel)) as trigger_data
         from platform.inbound_messages im
        where im.environment_id = $1 and im.id > $2 and im.id <= $3 and im.channel = $4 and im.user_key is not null and not im.opt_out
          and ($5::text is null or lower(btrim(coalesce(im.body, ''))) = lower($5))`,
      [a.environment_id, a.trigger_cursor ?? "0", last.id, t.channel, t.keyword ?? null],
    );
    await db.query("update platform.automations set trigger_cursor = $2 where id = $1", [a.id, last.id]);
    return created;
  }
  // Schedule or once: everyone currently in the audience, once per slot.
  if (!a.next_fire_at || a.next_fire_at.getTime() > Date.now()) return 0;
  const slot = a.next_fire_at.toISOString();
  const created = await insertRuns(
    db, a,
    `select m.user_key as person, '${t.type}:' || $2 as trigger_key, 0 as sort, jsonb_build_object('scheduled_for', $2::text) as trigger_data
       from platform.audience_members m join platform.audiences au on au.id = m.audience_id and au.status = 'active'
      where m.audience_id = $1 and m.exited_at is null`,
    [t.audienceId, slot],
  );
  // A one-time send fires once; trigger_cursor records the slot it fired for.
  if (t.type === "once") await db.query("update platform.automations set next_fire_at = null, trigger_cursor = 1 where id = $1", [a.id]);
  else await db.query("update platform.automations set next_fire_at = $2 where id = $1", [a.id, nextScheduled(new Date(), a.timezone, t)]);
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
          [run.id, final ? "failed" : "pending", final ? RUN_LOG.internalGaveUp : RUN_LOG.internalRetry],
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
  let exit: string | null = null;

  const deleting = await db.one(
    `select 1 from platform.privacy_requests where environment_id = $1 and kind = 'deletion' and status in ('received', 'processing') and (subject_user_id = $2 or subject_anonymous_id = $3)`,
    [run.environment_id, userId, anonymousId],
  );
  if (deleting) {
    status = "cancelled";
    entries.push({ at: now().toISOString(), step, type: "run", outcome: "cancelled", detail: RUN_LOG.deletionPending });
  } else if ((exit = await exitReason(env, definition))) {
    // Goal reached (with stop on conversion) or exit event: no further steps.
    entries.push({ at: now().toISOString(), step, type: "run", outcome: "exit", detail: exit });
    step = definition.steps.length;
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

async function executeStep(env: RunEnv, s: Step, index: number): Promise<StepResult> {
  const { db, run, automation, now } = env;
  const def = automation.definition;
  const { userId, anonymousId } = splitUserKey(run.user_key);
  const vars = { user: env.profile, event: (run.trigger_data.properties ?? {}) as Record<string, unknown> };

  if (MESSAGE_STEPS.has(s.type)) {
    // Quiet hours first (the run waits and retries this step), then the frequency cap at send time.
    if (def.quietHours && s.type !== "in_app") {
      const until = quietHoursEnd(now(), env.timezone, def.quietHours);
      if (until) return { next: "wait", until, advance: false, entry: { type: s.type, outcome: "waiting", detail: fill(RUN_LOG.quietHours, { start: def.quietHours.start, end: def.quietHours.end, timezone: env.timezone, until: until.toISOString() }) } };
    }
    if (def.frequencyCap) {
      const sent = await db.one<{ n: string }>(
        `select (select count(*) from platform.notifications where environment_id = $1 and user_key = $2 and status in ('sent', 'delivered', 'read', 'opened') and created_at > now() - make_interval(hours => $3))
              + (select count(*) from platform.in_app_messages where environment_id = $1 and user_key = $2 and created_at > now() - make_interval(hours => $3)) as n`,
        [run.environment_id, run.user_key, def.frequencyCap.hours],
      );
      if (Number(sent!.n) >= def.frequencyCap.messages) {
        return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: fill(RUN_LOG.frequencyCap, { n: sent!.n, hours: def.frequencyCap.hours, limit: def.frequencyCap.messages }) } };
      }
    }
  }

  switch (s.type) {
    case "delay": {
      const ms = s.amount * { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[s.unit];
      const until = new Date(now().getTime() + ms);
      return { next: "wait", until, advance: true, entry: { type: "delay", outcome: "waiting", detail: fill(RUN_LOG.until, { until: until.toISOString() }) } };
    }
    case "branch": {
      const ok = await personMatches(db, run.environment_id, run.user_key, s.condition, triggerTime(run));
      if (ok) return { next: "continue", entry: { type: "branch", outcome: "done", detail: RUN_LOG.conditionMet } };
      if (s.else === "exit") return { next: "exit", entry: { type: "branch", outcome: "exit", detail: RUN_LOG.conditionNotMetEnd } };
      return { next: "goto", to: s.else.goto, entry: { type: "branch", outcome: "done", detail: fill(RUN_LOG.conditionNotMetGoto, { n: s.else.goto + 1 }) } };
    }
    case "webhook": {
      const w = await db.one<{ status: string }>("select status from platform.webhooks where id = $1 and environment_id = $2", [s.webhookId, run.environment_id]);
      if (!w || w.status !== "active") return { next: "continue", entry: { type: "webhook", outcome: "failed", detail: w ? RUN_LOG.webhookDisabled : RUN_LOG.webhookGone } };
      const id = await enqueueDelivery(db, {
        organizationId: run.organization_id, environmentId: run.environment_id, webhookId: s.webhookId, eventType: "automation.webhook",
        idempotencyKey: `run:${run.id}:${index}`, automationRunId: run.id,
        data: { automation: { id: run.automation_id, name: automation.name, version: run.version }, run_id: run.id, step: index, user_key: run.user_key, user_id: userId, anonymous_id: anonymousId, trigger: run.trigger_data },
      });
      return { next: "continue", entry: { type: "webhook", outcome: "done", detail: id ? fill(RUN_LOG.deliveryQueued, { id }) : RUN_LOG.alreadyQueued } };
    }
    case "push":
      return sendPush(env, s, index, vars);
    case "email":
      return sendEmailStep(env, s, index, vars);
    case "whatsapp":
      return sendWhatsAppStep(env, s, index, vars);
    case "whatsapp_session":
    case "sms":
      return sendTextStep(env, s, index, vars);
    case "wait_outcome":
      return waitOutcome(env, s);
    case "in_app": {
      const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "in_app");
      if (blocked) return { next: "continue", entry: { type: "in_app", outcome: "skipped", detail: fill(RUN_LOG.notSent, { message: blocked }) } };
      const appId = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [run.environment_id]);
      const row = await db.one(
        `insert into platform.in_app_messages (organization_id, app_id, environment_id, user_key, automation_id, automation_run_id, step, title, body, button_text, deep_link, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(hours => $12))
         on conflict (automation_run_id, step) do nothing returning id`,
        [run.organization_id, appId!.app_id, run.environment_id, run.user_key, run.automation_id, run.id, index,
         renderTemplate(s.title, vars), renderTemplate(s.body, vars), s.buttonText ?? null, s.deepLink ?? null, s.expiresInHours],
      );
      return { next: "continue", entry: { type: "in_app", outcome: "done", detail: row ? fill(RUN_LOG.queuedForApp, { hours: s.expiresInHours }) : RUN_LOG.alreadyQueued } };
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
      if (!updated.length) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: RUN_LOG.noProfile } };
      env.profile = { ...env.profile, [s.property]: s.value };
      return { next: "continue", entry: { type: s.type, outcome: "done", detail: `${s.property} = ${value}` } };
    }
    case "exit":
      return { next: "exit", entry: { type: "exit", outcome: "exit", detail: RUN_LOG.exitStep } };
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
      return { next: "continue", entry: { type: s.type, outcome: "done", detail: row ? fill(RUN_LOG.sentEvent, { event: s.event }) : RUN_LOG.alreadySent } };
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

/** Why the run should end before its next step: the person converted (stop on conversion) or did the exit event since the trigger. */
async function exitReason(env: RunEnv, d: AutomationDefinition): Promise<string | null> {
  const did = (event: string) =>
    personMatches(env.db, env.run.environment_id, env.run.user_key, { type: "event", event, did: true, countOp: "gte", count: 1, withinDays: 30, sinceTrigger: true, where: [] }, triggerTime(env.run));
  if (d.goal?.stopOnConversion && (await did(d.goal.event))) return fill(RUN_LOG.converted, { event: d.goal.event });
  if (d.exitEvent && (await did(d.exitEvent))) return fill(RUN_LOG.exitEvent, { event: d.exitEvent });
  return null;
}

/** A test send has no run (empty id): its notification has no run or step and is flagged as a test. */
const target = (run: RunClaim, step: number) => ({ organizationId: run.organization_id, environmentId: run.environment_id, userKey: run.user_key, runId: run.id || null, step: run.id ? step : null });

/**
 * Sends one message step to one person now, through exactly the code a flow
 * or campaign run uses (consent and suppression, the 24-hour window,
 * template approval, media, the provider adapter), but without a run:
 * no quiet hours or frequency cap, and the notification is a test send.
 */
export async function sendStepNow(
  db: Db,
  creds: DeliveryCredentials,
  who: { organizationId: string; environmentId: string; userKey: string; profile: Record<string, unknown>; timezone: string },
  s: Extract<Step, { type: "whatsapp" | "whatsapp_session" | "sms" }>,
): Promise<{ outcome: string; detail: string }> {
  const run: RunClaim = {
    id: "", organization_id: who.organizationId, automation_id: "", environment_id: who.environmentId, user_key: who.userKey, current_step: 0, version: 0,
    trigger_data: {}, started_at: new Date(), attempts: 0,
  };
  const env: RunEnv = { db, run, automation: { name: "test", definition: {} as AutomationDefinition, status: "draft" }, timezone: who.timezone, creds, now: () => new Date(), profile: who.profile };
  const vars = { user: who.profile, event: {} };
  const r = s.type === "whatsapp" ? await sendWhatsAppStep(env, s, 0, vars) : await sendTextStep(env, s, 0, vars);
  return { outcome: r.entry.outcome, detail: r.entry.detail ?? "" };
}

async function sendPush(env: RunEnv, s: Extract<Step, { type: "push" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "push");
  if (blocked) return { next: "continue", entry: { type: "push", outcome: "skipped", detail: fill(RUN_LOG.notSent, { message: blocked }) } };
  const content: PushContent = {
    title: renderTemplate(s.title, vars),
    body: renderTemplate(s.body, vars),
    data: { automation_id: run.automation_id, run_id: run.id, ...(s.deepLink ? { deep_link: s.deepLink } : {}) },
  };
  const r = await deliverPush(db, creds, target(run, index), content);
  if (!r.devices) return { next: "continue", entry: { type: "push", outcome: "skipped", detail: RUN_LOG.noPushToken } };
  const detail = [fill(r.devices === 1 ? RUN_LOG.sentToDevice : RUN_LOG.sentToDevices, { sent: r.sent, devices: r.devices }), ...r.problems].join("; ");
  return { next: "continue", entry: { type: "push", outcome: r.sent ? "done" : "failed", detail } };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function sendEmailStep(env: RunEnv, s: Extract<Step, { type: "email" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const to = typeof env.profile.email === "string" ? env.profile.email.trim() : "";
  if (!to || !EMAIL.test(to)) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: RUN_LOG.noEmail } };
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "email");
  if (blocked) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: fill(RUN_LOG.notSent, { message: blocked }) } };
  let content = { subject: s.subject ?? "", body: s.body ?? "" };
  if (s.templateId) {
    const t = await getEmailTemplate(db, run.environment_id, s.templateId);
    if (!t) return { next: "continue", entry: { type: "email", outcome: "failed", detail: RUN_LOG.templateDeleted } };
    content = { subject: t.subject, body: t.body };
  }
  const r = await deliverEmail(db, creds, target(run, index), {
    to, subject: renderTemplate(content.subject, vars), body: renderTemplate(content.body, vars), templateId: s.templateId ?? null, tag: run.automation_id,
  });
  if (!r.attempted) return { next: "continue", entry: { type: "email", outcome: "skipped", detail: RUN_LOG.alreadyAttempted } };
  return { next: "continue", entry: { type: "email", outcome: r.ok ? "done" : "failed", detail: r.ok ? RUN_LOG.sent : r.error ?? RUN_LOG.failed } };
}

async function appOf(db: Db, environmentId: string): Promise<string> {
  return (await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]))!.app_id;
}

/** The media file's public URL, or why it can't be attached (the step then fails with that reason). */
async function mediaFor(env: RunEnv, assetId: string, channel: "whatsapp" | "sms"): Promise<{ link: string } | { error: string }> {
  const r = await resolveMedia(env.db, { organizationId: env.run.organization_id, appId: await appOf(env.db, env.run.environment_id), assetId, channel });
  return r.available ? { link: r.media.url } : { error: fill(RUN_LOG.mediaUnavailable, { message: r.reason }) };
}

async function sendWhatsAppStep(env: RunEnv, s: Extract<Step, { type: "whatsapp" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const to = toE164(env.profile[s.phoneProperty]);
  if (!to) return { next: "continue", entry: { type: "whatsapp", outcome: "skipped", detail: fill(RUN_LOG.noPhone, { property: s.phoneProperty }) } };
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, "whatsapp");
  if (blocked) return { next: "continue", entry: { type: "whatsapp", outcome: "skipped", detail: fill(RUN_LOG.notSent, { message: blocked }) } };
  const template = await findTemplate(db, run.environment_id, s.template, s.language, s.provider);
  if (!template || template.status !== "APPROVED") {
    return { next: "continue", entry: { type: "whatsapp", outcome: "failed", detail: template ? fill(RUN_LOG.templateNotApproved, { template: s.template, status: template.status.toLowerCase() }) : fill(RUN_LOG.templateNotSynced, { template: s.template, language: s.language }) } };
  }
  const kind = template.header_format ? (HEADER_MEDIA[template.header_format] as "image" | "video" | "document" | undefined) : undefined;
  let headerMedia: { kind: "image" | "video" | "document"; link: string } | undefined;
  if (kind) {
    const m = s.mediaAssetId ? await mediaFor(env, s.mediaAssetId, "whatsapp") : { error: fill(RUN_LOG.mediaUnavailable, { message: "no media file chosen" }) };
    if ("error" in m) return { next: "continue", entry: { type: "whatsapp", outcome: "failed", detail: m.error } };
    headerMedia = { kind, link: m.link };
  }
  const render = (p: string) => renderTemplate(p, vars).trim() || "-";
  const r = await deliverMessage(db, creds, target(run, index), s.provider, {
    kind: "template", channel: "whatsapp", to,
    // Meta sends by template name; Twilio by the Content SID it was synced from.
    template: s.provider === "twilio" ? template.external_id ?? "" : s.template,
    language: s.language,
    bodyParams: s.bodyParams.map(render),
    headerParams: s.headerParams.map(render),
    variableKeys: template.variables ?? [],
    headerMedia,
  });
  if (!r.attempted) return { next: "continue", entry: { type: "whatsapp", outcome: "skipped", detail: RUN_LOG.alreadyAttempted } };
  return { next: "continue", entry: { type: "whatsapp", outcome: r.ok ? "done" : "failed", detail: r.ok ? RUN_LOG.sentTemplate : r.error ?? RUN_LOG.failed } };
}

/** A free-form WhatsApp message (only inside the 24-hour window) or an SMS (MMS only where the provider allows it). */
async function sendTextStep(env: RunEnv, s: Extract<Step, { type: "whatsapp_session" | "sms" }>, index: number, vars: Parameters<typeof renderTemplate>[1]): Promise<StepResult> {
  const { db, run, creds } = env;
  const channel = s.type === "sms" ? "sms" : "whatsapp";
  const to = toE164(env.profile[s.phoneProperty]);
  if (!to) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: fill(RUN_LOG.noPhone, { property: s.phoneProperty }) } };
  const blocked = await messagingBlocked(db, run.environment_id, run.user_key, channel);
  if (blocked) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: fill(RUN_LOG.notSent, { message: blocked }) } };
  if (channel === "whatsapp" && !sessionOpen(await lastInboundAt(db, run.environment_id, "whatsapp", to), env.now())) {
    return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: RUN_LOG.outsideWindow } };
  }
  let media: { kind: "image" | "video" | "audio" | "document"; link: string } | undefined;
  if (s.mediaAssetId) {
    if (channel === "sms" && !mmsAllowed(s.provider, to)) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: RUN_LOG.mmsNotAllowed } };
    const m = await mediaFor(env, s.mediaAssetId, channel);
    if ("error" in m) return { next: "continue", entry: { type: s.type, outcome: "failed", detail: m.error } };
    media = { kind: "image", link: m.link };
  }
  const r = await deliverMessage(db, creds, target(run, index), s.provider, { kind: "text", channel, to, text: renderTemplate(s.text, vars), media });
  if (!r.attempted) return { next: "continue", entry: { type: s.type, outcome: "skipped", detail: RUN_LOG.alreadyAttempted } };
  return { next: "continue", entry: { type: s.type, outcome: r.ok ? "done" : "failed", detail: r.ok ? RUN_LOG.sentMessage : r.error ?? RUN_LOG.failed } };
}

/** How long a run waits between checks of a delivery outcome. */
const OUTCOME_POLL_MS = 10 * 60_000;

/** Continues when an earlier message step reached the outcome; waits (re-checking) until its deadline; then takes the else path. */
async function waitOutcome(env: RunEnv, s: Extract<Step, { type: "wait_outcome" }>): Promise<StepResult> {
  const { db, run, now } = env;
  const label = OUTCOME_LABELS[s.outcome];
  const params = { step: s.step + 1, outcome: label };
  const n = await db.one<{ created_at: Date; status: string; delivered_at: Date | null; read_at: Date | null; channel: string; recipient_hash: string | null }>(
    `select created_at, status, delivered_at, read_at, channel, recipient_hash from platform.notifications
      where automation_run_id = $1 and step = $2 order by created_at limit 1`,
    [run.id, s.step],
  );
  const missed = (): StepResult => s.else === "exit"
    ? { next: "exit", entry: { type: "wait_outcome", outcome: "exit", detail: fill(RUN_LOG.outcomeMissedEnd, params) } }
    : { next: "goto", to: s.else.goto, entry: { type: "wait_outcome", outcome: "done", detail: fill(RUN_LOG.outcomeMissedGoto, { ...params, n: s.else.goto + 1 }) } };
  if (!n) {
    const noMessage = fill(RUN_LOG.outcomeNoMessage, { step: s.step + 1 });
    return s.else === "exit" ? { next: "exit", entry: { type: "wait_outcome", outcome: "exit", detail: noMessage } } : { next: "goto", to: s.else.goto, entry: { type: "wait_outcome", outcome: "done", detail: noMessage } };
  }
  let reached = false;
  if (s.outcome === "failed") reached = n.status === "failed";
  else if (s.outcome === "delivered") reached = Boolean(n.delivered_at) || n.status === "delivered" || n.status === "read";
  else if (s.outcome === "read") reached = Boolean(n.read_at) || n.status === "read";
  else if (n.recipient_hash) {
    const reply = await db.one(
      "select 1 from platform.inbound_messages where environment_id = $1 and channel = $2 and sender_hash = $3 and received_at >= $4 and not opt_out limit 1",
      [run.environment_id, n.channel, n.recipient_hash, n.created_at],
    );
    reached = Boolean(reply);
  }
  if (reached) return { next: "continue", entry: { type: "wait_outcome", outcome: "done", detail: fill(RUN_LOG.outcomeReached, params) } };
  const deadline = new Date(n.created_at).getTime() + s.withinHours * 3_600_000;
  const at = now().getTime();
  if (at >= deadline || (s.outcome !== "failed" && n.status === "failed")) return missed();
  const until = new Date(Math.min(deadline, at + OUTCOME_POLL_MS));
  return { next: "wait", until, advance: false, entry: { type: "wait_outcome", outcome: "waiting", detail: fill(RUN_LOG.outcomeWaiting, { ...params, until: new Date(deadline).toISOString() }) } };
}
