import "server-only";
import { z } from "zod";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { assertCan } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import type { Requester } from "./service";
import { msg } from "@/i18n/translate";

/**
 * End-user consent and suppression lists, per environment.
 *
 * Consent
 *   The SDK (or a backend) sends a `consent` event with the purposes that
 *   changed: { analytics, marketing, push, attribution } as booleans. At
 *   ingestion each change is appended to `consent_records` (history, used by
 *   exports and the dashboard) and folded into `consent_state` (the latest
 *   decision per user key and purpose, read by ingestion on every batch).
 *
 *   User keys follow the convention used by audiences and automation: the
 *   customer's `user_id`, or `anon:<anonymous_id>` for an install. A change
 *   carrying both ids is written under both keys, so consent given before
 *   login follows the user and consent given while logged in also covers the
 *   install's anonymous activity. When two keys disagree the most recent
 *   decision wins (see `effectiveConsent`).
 *
 * Suppression
 *   `suppressions` lists user keys that must not be messaged on a channel:
 *   `marketing` (any marketing message, whatever the medium), `push` or
 *   `email`. Rows come from the dashboard, from a secret key with
 *   `privacy:write`, or automatically from consent: denying marketing adds a
 *   `marketing` suppression and denying push adds a `push` one; granting again
 *   removes only those automatic rows, never manual ones.
 */

export const PURPOSES = ["analytics", "marketing", "push", "attribution"] as const;
export type Purpose = (typeof PURPOSES)[number];
export const CHANNELS = ["marketing", "push", "email", "whatsapp", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];
export type ConsentSource = "sdk" | "api" | "dashboard";

/** Which suppression channel a denied purpose turns on. */
const PURPOSE_CHANNEL: Partial<Record<Purpose, Channel>> = { marketing: "marketing", push: "push" };

/** Current decision for one purpose: true granted, false denied, null no decision recorded. */
export type ConsentDecision = boolean | null;

export interface ConsentState {
  analytics: ConsentDecision;
  marketing: ConsentDecision;
  push: ConsentDecision;
  attribution: ConsentDecision;
  /** When the most recent of these decisions was made; null when there is none. */
  updatedAt: Date | null;
}

/** `user_id` → `user_id`; `anonymous_id` → `anon:<anonymous_id>`. */
export function userKeyOf(ids: { userId?: string | null; anonymousId?: string | null }): string | null {
  if (ids.userId) return ids.userId;
  if (ids.anonymousId) return `anon:${ids.anonymousId}`;
  return null;
}

/** Every key a person or install is known under: the user id first, then the install. */
export function userKeysOf(ids: { userId?: string | null; anonymousId?: string | null }): string[] {
  const keys: string[] = [];
  if (ids.userId) keys.push(ids.userId);
  if (ids.anonymousId) keys.push(`anon:${ids.anonymousId}`);
  return keys;
}

export interface StateRow {
  user_key: string;
  purpose: Purpose;
  granted: boolean;
  updated_at: Date;
}

/**
 * Stitching rule: the decision for a purpose is the most recent one recorded
 * under any of the keys (user id and install). Pure; exported for tests.
 */
export function effectiveConsent(rows: StateRow[], keys: string[], purpose: Purpose): ConsentDecision {
  let best: StateRow | null = null;
  for (const r of rows) {
    if (r.purpose !== purpose || !keys.includes(r.user_key)) continue;
    if (!best || new Date(r.updated_at).getTime() > new Date(best.updated_at).getTime()) best = r;
  }
  return best ? best.granted : null;
}

function toState(rows: StateRow[], keys: string[]): ConsentState {
  const state: ConsentState = { analytics: null, marketing: null, push: null, attribution: null, updatedAt: null };
  for (const p of PURPOSES) state[p] = effectiveConsent(rows, keys, p);
  for (const r of rows) {
    if (!keys.includes(r.user_key)) continue;
    const at = new Date(r.updated_at);
    if (!state.updatedAt || at > state.updatedAt) state.updatedAt = at;
  }
  return state;
}

/** Consent state rows for the given keys in one environment (primary-key lookup). */
export async function loadStateRows(db: Db, environmentId: string, keys: string[], purposes: readonly Purpose[] = PURPOSES): Promise<StateRow[]> {
  if (!keys.length) return [];
  return db.query<StateRow>(
    `select user_key, purpose, granted, updated_at from platform.consent_state
      where environment_id = $1 and user_key = any($2) and purpose = any($3)`,
    [environmentId, keys, purposes],
  );
}

// ── Functions for other modules (automation, audiences) ──────────────────────

/**
 * Current consent of one user key in an environment, after stitching: for a
 * `user_id` the user's own decisions; for `anon:<id>` the install's. A purpose
 * with no recorded decision is `null`. The SDK's default (`consentDefault`,
 * "granted" unless the app configures otherwise) is not known here, so treat
 * `null` as "no explicit decision": for marketing sends, check
 * `isSuppressed(..., "marketing")`, which already reflects denials.
 *
 * Pass `db` to run inside your own transaction (it must be scoped to the
 * environment's organization, or be a `withSystem` connection); without it the
 * lookup runs in its own system transaction, explicitly scoped by environment.
 */
export async function consentState(environmentId: string, userKey: string, db?: Db): Promise<ConsentState> {
  const run = (d: Db) => loadStateRows(d, environmentId, [userKey]).then((rows) => toState(rows, [userKey]));
  return db ? run(db) : withSystem(run);
}

/**
 * True when `userKey` must not be messaged on `channel` in this environment.
 * Automation must call this before every send:
 *   - marketing messages: check "marketing" and the medium ("push" / "email");
 *   - transactional messages: check only the medium.
 * Covers manual and API entries and automatic ones from denied marketing /
 * push consent. `db` as in `consentState`.
 */
export async function isSuppressed(environmentId: string, userKey: string, channel: Channel, db?: Db): Promise<boolean> {
  const run = async (d: Db) => (await suppressedKeys(environmentId, [userKey], channel, d)).has(userKey);
  return db ? run(db) : withSystem(run);
}

/** Batch form of `isSuppressed` for audience-sized sends: the subset of `userKeys` suppressed on `channel`. */
export async function suppressedKeys(environmentId: string, userKeys: string[], channel: Channel, db?: Db): Promise<Set<string>> {
  if (!userKeys.length) return new Set();
  const run = (d: Db) =>
    d.query<{ user_key: string }>(
      "select distinct user_key from platform.suppressions where environment_id = $1 and channel = $2 and user_key = any($3)",
      [environmentId, channel, userKeys],
    );
  const rows = db ? await run(db) : await withSystem(run);
  return new Set(rows.map((r) => r.user_key));
}

// ── Ingestion ────────────────────────────────────────────────────────────────

export interface ConsentChange {
  eventId: string;
  timestamp: string;
  userId: string | null;
  anonymousId: string | null;
  consent: Partial<Record<Purpose, boolean>>;
}

/**
 * Records consent changes received by ingestion, inside its transaction
 * (withSystem, so everything is scoped explicitly). Idempotent per event id:
 * a retried change is not recorded again. Returns the event ids that were new.
 * State only moves forward in time, so a late retry of an older change never
 * overrides a newer decision.
 */
export async function recordConsentChanges(
  db: Db,
  scope: { organizationId: string; environmentId: string },
  changes: ConsentChange[],
  source: ConsentSource,
): Promise<Set<string>> {
  const rows = changes.flatMap((c) =>
    PURPOSES.filter((p) => typeof c.consent[p] === "boolean").map((p) => ({
      event_id: c.eventId,
      user_key: userKeyOf(c),
      user_id: c.userId,
      anonymous_id: c.anonymousId,
      purpose: p,
      granted: c.consent[p]!,
      recorded_at: c.timestamp,
    })),
  );
  if (!rows.length) return new Set();
  const inserted = await db.query<{ event_id: string; user_id: string | null; anonymous_id: string | null; purpose: Purpose; granted: boolean; recorded_at: Date }>(
    `insert into platform.consent_records (organization_id, environment_id, user_key, purpose, granted, source, recorded_at, user_id, anonymous_id, event_id)
     select $1, $2, r.user_key, r.purpose, r.granted, $3, r.recorded_at, r.user_id, r.anonymous_id, r.event_id
       from jsonb_to_recordset($4::jsonb) as r(event_id text, user_key text, user_id text, anonymous_id text, purpose text, granted boolean, recorded_at timestamptz)
     on conflict (environment_id, event_id, purpose) where event_id is not null do nothing
     returning event_id, user_id, anonymous_id, purpose, granted, recorded_at`,
    [scope.organizationId, scope.environmentId, source, JSON.stringify(rows)],
  );
  if (!inserted.length) return new Set();

  // Fold into the current state under every key of the change; only newer decisions win.
  const state = inserted.flatMap((r) => userKeysOf({ userId: r.user_id, anonymousId: r.anonymous_id }).map((k) => ({ user_key: k, purpose: r.purpose, granted: r.granted, at: r.recorded_at })));
  // One row per (key, purpose) per statement: keep the latest of this batch.
  const latest = new Map<string, (typeof state)[number]>();
  for (const s of state) {
    const k = `${s.user_key}\u0000${s.purpose}`;
    const prev = latest.get(k);
    if (!prev || new Date(s.at) >= new Date(prev.at)) latest.set(k, s);
  }
  await db.query(
    `insert into platform.consent_state as c (organization_id, environment_id, user_key, purpose, granted, source, updated_at)
     select $1, $2, s.user_key, s.purpose, s.granted, $3, s.at
       from jsonb_to_recordset($4::jsonb) as s(user_key text, purpose text, granted boolean, at timestamptz)
     on conflict (environment_id, user_key, purpose) do update
       set granted = excluded.granted, source = excluded.source, updated_at = excluded.updated_at
       where excluded.updated_at >= c.updated_at`,
    [scope.organizationId, scope.environmentId, source, JSON.stringify([...latest.values()])],
  );

  // Automatic suppressions follow the resulting state of the touched keys.
  const touched = [...new Set([...latest.values()].filter((s) => PURPOSE_CHANNEL[s.purpose]).map((s) => s.user_key))];
  if (touched.length) {
    const current = await loadStateRows(db, scope.environmentId, touched, ["marketing", "push"]);
    const add = current.filter((r) => !r.granted).map((r) => ({ user_key: r.user_key, channel: PURPOSE_CHANNEL[r.purpose]! }));
    const remove = current.filter((r) => r.granted).map((r) => ({ user_key: r.user_key, channel: PURPOSE_CHANNEL[r.purpose]! }));
    if (add.length) {
      await db.query(
        `insert into platform.suppressions (organization_id, environment_id, user_key, channel, source, reason)
         select $1, $2, s.user_key, s.channel, 'consent', 'Consent denied'
           from jsonb_to_recordset($3::jsonb) as s(user_key text, channel text)
         on conflict (environment_id, user_key, channel, source) do nothing`,
        [scope.organizationId, scope.environmentId, JSON.stringify(add)],
      );
    }
    if (remove.length) {
      await db.query(
        `delete from platform.suppressions p using jsonb_to_recordset($2::jsonb) as s(user_key text, channel text)
          where p.environment_id = $1 and p.source = 'consent' and p.user_key = s.user_key and p.channel = s.channel`,
        [scope.environmentId, JSON.stringify(remove)],
      );
    }
  }
  return new Set(inserted.map((r) => r.event_id));
}

// ── Dashboard and API ────────────────────────────────────────────────────────

function scopeOf(req: Requester) {
  if (req.kind === "user") {
    assertCan(req.ctx.role, "privacy.manage");
    return { organizationId: req.ctx.organizationId, userId: req.ctx.userId };
  }
  return { organizationId: req.organizationId, userId: null };
}

async function assertEnvironment(db: Db, req: Requester, environmentId: string) {
  if (req.kind === "api_key" && req.environmentId !== environmentId) throw new NotFoundError("Environment");
  const env = await db.one("select 1 as ok from platform.environments where id = $1", [environmentId]);
  if (!env) throw new NotFoundError("Environment");
}

export interface ConsentOverviewPoint {
  day: string;
  purpose: Purpose;
  granted: number;
  denied: number;
  /** Installs seen in this environment by that day with no decision recorded for the purpose. */
  pending: number;
}

/**
 * Daily consent totals for the last `days` days (at most 90): per purpose, how
 * many installs (or users, for changes sent without an anonymous id) had
 * granted or denied as of the end of each day, by their latest decision, and
 * how many installs seen by then had no decision. The last day is today.
 */
export async function consentOverview(ctx: TenantContext, environmentId: string, days = 30): Promise<ConsentOverviewPoint[]> {
  assertCan(ctx.role, "privacy.manage");
  const n = Math.min(Math.max(Math.trunc(days) || 30, 1), 90);
  const rows = await withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, (db) =>
    db.query<{ day: string; purpose: Purpose; granted: string; denied: string; pending: string }>(
      `with days as (
         select d::date as day, d + interval '1 day' as day_end
           from generate_series(date_trunc('day', now()) - make_interval(days => $2 - 1), date_trunc('day', now()), interval '1 day') d),
       purposes as (select unnest($3::text[]) as purpose)
       select d.day, p.purpose, s.granted, s.denied,
              (select count(*) from platform.anonymous_users a
                where a.environment_id = $1 and a.first_seen_at < d.day_end
                  and not exists (select 1 from platform.consent_records r
                                   where r.environment_id = $1 and r.anonymous_id = a.anonymous_id
                                     and r.purpose = p.purpose and r.recorded_at < d.day_end)) as pending
         from days d cross join purposes p
         cross join lateral (
           select count(*) filter (where l.granted) as granted, count(*) filter (where not l.granted) as denied
             from (select distinct on (coalesce('anon:' || r.anonymous_id, r.user_key)) r.granted
                     from platform.consent_records r
                    where r.environment_id = $1 and r.purpose = p.purpose and r.recorded_at < d.day_end
                    order by coalesce('anon:' || r.anonymous_id, r.user_key), r.recorded_at desc, r.received_at desc) l) s
        order by d.day, p.purpose`,
      [environmentId, n, PURPOSES],
    ),
  );
  return rows.map((r) => ({ day: r.day, purpose: r.purpose, granted: Number(r.granted), denied: Number(r.denied), pending: Number(r.pending) }));
}

const lookupSchema = z
  .object({
    userId: z.string().trim().max(256).optional().transform((v) => v || undefined),
    anonymousId: z.string().trim().max(256).optional().transform((v) => v || undefined),
  })
  .refine((s) => s.userId || s.anonymousId, msg("Provide a user_id, an anonymous_id, or both."));

export interface ConsentHistoryRow {
  purpose: Purpose;
  granted: boolean;
  source: ConsentSource;
  user_id: string | null;
  anonymous_id: string | null;
  recorded_at: Date;
  received_at: Date;
}

export interface SuppressionRow {
  id: string;
  user_key: string;
  channel: Channel;
  source: "manual" | "api" | "consent" | "unsubscribe";
  reason: string | null;
  created_by_name: string | null;
  created_at: Date;
}

export interface ConsentLookup {
  keys: string[];
  state: ConsentState;
  history: ConsentHistoryRow[];
  suppressions: SuppressionRow[];
}

/** One person's or install's current consent (stitched across both ids), history (newest first, ≤200) and suppressions. */
export async function lookupConsent(req: Requester, environmentId: string, input: unknown): Promise<ConsentLookup> {
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? msg("Invalid subject."));
  const keys = userKeysOf(parsed.data);
  return withTenant(scopeOf(req), async (db) => {
    await assertEnvironment(db, req, environmentId);
    const state = toState(await loadStateRows(db, environmentId, keys), keys);
    const history = await db.query<ConsentHistoryRow>(
      `select purpose, granted, source, user_id, anonymous_id, recorded_at, received_at from platform.consent_records
        where environment_id = $1 and (user_key = any($2) or anonymous_id = $3)
        order by recorded_at desc, received_at desc limit 200`,
      [environmentId, keys, parsed.data.anonymousId ?? null],
    );
    const suppressions = await db.query<SuppressionRow>(
      `select s.id, s.user_key, s.channel, s.source, s.reason, u.name as created_by_name, s.created_at
         from platform.suppressions s left join platform.users u on u.id = s.created_by
        where s.environment_id = $1 and s.user_key = any($2) order by s.created_at desc`,
      [environmentId, keys],
    );
    return { keys, state, history, suppressions };
  });
}

const suppressionInput = z
  .object({
    userId: z.string().trim().max(256).optional().transform((v) => v || undefined),
    anonymousId: z.string().trim().max(256).optional().transform((v) => v || undefined),
    channels: z.array(z.enum(CHANNELS)).min(1, msg("Choose at least one channel: marketing, push, email, whatsapp or sms.")).max(5),
    reason: z.string().trim().max(500).optional().transform((v) => v || undefined),
  })
  .refine((s) => s.userId || s.anonymousId, msg("Provide a user_id or an anonymous_id."));

/** Adds a user key to the suppression list for each channel. Repeating an add only updates the reason. */
export async function addSuppression(req: Requester, environmentId: string, input: unknown): Promise<{ userKey: string; channels: Channel[] }> {
  const parsed = suppressionInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? msg("Invalid suppression."));
  const s = parsed.data;
  const userKey = userKeyOf(s)!;
  const channels = [...new Set(s.channels)];
  const scope = scopeOf(req);
  const source = req.kind === "user" ? "manual" : "api";
  await withTenant(scope, async (db) => {
    await assertEnvironment(db, req, environmentId);
    await db.query(
      `insert into platform.suppressions (organization_id, environment_id, user_key, channel, source, reason, created_by)
       select $1, $2, $3, c, $4, $5, $6 from unnest($7::text[]) c
       on conflict (environment_id, user_key, channel, source) do update set reason = coalesce(excluded.reason, platform.suppressions.reason)`,
      [scope.organizationId, environmentId, userKey, source, s.reason ?? null, scope.userId, channels],
    );
    await audit(db, {
      organizationId: scope.organizationId,
      actorUserId: scope.userId,
      actorType: req.kind === "user" ? "user" : "api_key",
      action: "privacy.suppression_added",
      targetType: "suppression",
      targetId: userKey,
      metadata: { environment_id: environmentId, channels },
    });
  });
  return { userKey, channels };
}

/**
 * Removes manual and API suppressions of a user key on the given channels.
 * Automatic ones (from denied consent) stay until the user grants consent
 * again; `remaining` lists the channels still suppressed because of them.
 */
export async function removeSuppression(req: Requester, environmentId: string, input: unknown): Promise<{ userKey: string; removed: number; remaining: Channel[] }> {
  const parsed = suppressionInput.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? msg("Invalid suppression."));
  const s = parsed.data;
  const userKey = userKeyOf(s)!;
  const scope = scopeOf(req);
  return withTenant(scope, async (db) => {
    await assertEnvironment(db, req, environmentId);
    const removed = await db.query(
      "delete from platform.suppressions where environment_id = $1 and user_key = $2 and channel = any($3) and source in ('manual', 'api') returning 1",
      [environmentId, userKey, s.channels],
    );
    const remaining = await db.query<{ channel: Channel }>(
      "select distinct channel from platform.suppressions where environment_id = $1 and user_key = $2 and channel = any($3) order by channel",
      [environmentId, userKey, s.channels],
    );
    if (removed.length) {
      await audit(db, {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        actorType: req.kind === "user" ? "user" : "api_key",
        action: "privacy.suppression_removed",
        targetType: "suppression",
        targetId: userKey,
        metadata: { environment_id: environmentId, channels: s.channels, removed: removed.length },
      });
    }
    return { userKey, removed: removed.length, remaining: remaining.map((r) => r.channel) };
  });
}

export const SUPPRESSION_PAGE_MAX = 500;

/**
 * The environment's suppression list, newest first. `before` is the `cursor`
 * of the previous page. Optional filters: channel, and an exact user key.
 */
export async function listSuppressions(
  req: Requester,
  environmentId: string,
  opts: { channel?: string; userKey?: string; limit?: number; before?: string } = {},
): Promise<{ rows: SuppressionRow[]; cursor: string | null }> {
  if (opts.channel && !(CHANNELS as readonly string[]).includes(opts.channel)) throw new ValidationError(msg("channel must be marketing, push, email, whatsapp or sms."));
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), SUPPRESSION_PAGE_MAX);
  let after: { at: string; id: string } | null = null;
  if (opts.before) {
    const [at, id] = Buffer.from(opts.before, "base64url").toString("utf8").split("|");
    if (!at || !id || Number.isNaN(Date.parse(at)) || !z.string().uuid().safeParse(id).success) throw new ValidationError(msg("Invalid cursor."));
    after = { at, id };
  }
  return withTenant(scopeOf(req), async (db) => {
    await assertEnvironment(db, req, environmentId);
    const rows = await db.query<SuppressionRow>(
      `select s.id, s.user_key, s.channel, s.source, s.reason, u.name as created_by_name, s.created_at
         from platform.suppressions s left join platform.users u on u.id = s.created_by
        where s.environment_id = $1
          and ($2::text is null or s.channel = $2)
          and ($3::text is null or s.user_key = $3)
          and ($4::timestamptz is null or (date_trunc('milliseconds', s.created_at), s.id) < ($4::timestamptz, $5::uuid))
        order by date_trunc('milliseconds', s.created_at) desc, s.id desc limit $6`,
      [environmentId, opts.channel || null, opts.userKey || null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const more = rows.length > limit;
    if (more) rows.length = limit;
    const last = rows[rows.length - 1];
    return { rows, cursor: more && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString("base64url") : null };
  });
}

/** Totals for the dashboard header: suppressed keys per channel. */
export async function suppressionCounts(ctx: TenantContext, environmentId: string): Promise<Record<Channel, number>> {
  assertCan(ctx.role, "privacy.manage");
  const rows = await withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, (db) =>
    db.query<{ channel: Channel; n: string }>(
      "select channel, count(distinct user_key) as n from platform.suppressions where environment_id = $1 group by channel",
      [environmentId],
    ),
  );
  const out: Record<Channel, number> = { marketing: 0, push: 0, email: 0, whatsapp: 0, sms: 0 };
  for (const r of rows) out[r.channel] = Number(r.n);
  return out;
}
