import "server-only";
import { msg } from "@/i18n/translate";
import { withParams } from "@/modules/organizations/messages";
import { withSystem, type Db } from "@/lib/db";
import { PlanLimitError } from "@/lib/errors";
import { asLimit, canAdd, eventHardCap, eventState, LIMIT_FEATURES, usagePeriod, type LimitKey, type LimitState } from "./limits";
import { envNumber } from "@/lib/env-number";
import { entitled } from "./plans";

/**
 * Plan-limit enforcement. Limits are data (platform.plan_features); a null or
 * absent value is unlimited.
 *
 * Apps and seats: checked inside the transaction that adds one, under a
 * per-organization advisory lock so two concurrent requests can't both take
 * the last slot.
 *
 * Monthly events: checked on every ingestion request against an in-process
 * cache of the organization's allowance and month-to-date usage (refreshed
 * every PLAN_USAGE_CACHE_MS, 30 s by default), so ingestion pays one small
 * query per organization per window, not per event. Events accepted by this
 * process are added to the cached count in between refreshes.
 */

/** The organization's limit for `key` (null = unlimited). Works in tenant and system transactions. */
export async function planLimit(db: Db, organizationId: string, key: LimitKey): Promise<number | null> {
  const row = await db.one<{ value: unknown }>(
    `select f.value from platform.organizations o
       join platform.plan_features f on f.plan_id = o.plan_id and f.feature = $2
      where o.id = $1`,
    [organizationId, LIMIT_FEATURES[key]],
  );
  return asLimit(row?.value);
}

/**
 * Feature entitlement (plan_features `feature.<name>`): allowed unless the
 * organization's plan explicitly sets it to false (plans.ts entitled()). Works
 * in tenant and system transactions. Independent of the payment provider, so
 * an unconfigured provider never takes a feature away.
 */
export async function featureEntitled(db: Db, organizationId: string, feature: string): Promise<boolean> {
  const row = await db.one<{ value: unknown }>(
    `select f.value from platform.organizations o
       join platform.plan_features f on f.plan_id = o.plan_id and f.feature = $2
      where o.id = $1`,
    [organizationId, `feature.${feature}`],
  );
  return entitled(row ? { [`feature.${feature}`]: row.value } : null, feature);
}

/** Refuses with plan_limit_exceeded (403) when the plan doesn't include `feature`. */
export async function assertEntitled(db: Db, organizationId: string, feature: string): Promise<void> {
  if (!(await featureEntitled(db, organizationId, feature))) {
    throw new PlanLimitError(msg("Your plan doesn't include this feature. Upgrade the plan to use it."), "feature");
  }
}

async function lockOrg(db: Db, what: string, organizationId: string) {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))", [what, organizationId]);
}

/** Refuses a new app when the organization already has as many active apps as its plan allows. */
export async function assertCanAddApp(db: Db, organizationId: string): Promise<void> {
  await lockOrg(db, "org-apps", organizationId);
  const limit = await planLimit(db, organizationId, "apps");
  if (limit === null) return;
  const row = await db.one<{ n: string }>("select count(*) as n from platform.apps where organization_id = $1 and status = 'active'", [organizationId]);
  if (!canAdd(Number(row!.n), limit))
    throw withParams(
      (m) => new PlanLimitError(m, "apps"),
      limit === 1 ? msg("Your plan includes {limit} app. Upgrade the plan to add another.") : msg("Your plan includes {limit} apps. Upgrade the plan to add another."),
      { limit },
    );
}

/**
 * Members plus pending invitations count as seats, so an organization can't
 * hand out more invitations than it can accept. Uses the same lock as other
 * membership changes.
 */
export async function seatsUsed(db: Db, organizationId: string): Promise<{ members: number; pending: number }> {
  const row = await db.one<{ members: string; pending: string }>(
    `select (select count(*) from platform.organization_members where organization_id = $1) as members,
            (select count(*) from platform.organization_invitations
              where organization_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()) as pending`,
    [organizationId],
  );
  return { members: Number(row!.members), pending: Number(row!.pending) };
}

export async function assertCanInvite(db: Db, organizationId: string): Promise<void> {
  await lockOrg(db, "org-members", organizationId);
  const limit = await planLimit(db, organizationId, "seats");
  if (limit === null) return;
  const { members, pending } = await seatsUsed(db, organizationId);
  if (!canAdd(members + pending, limit))
    throw withParams(
      (m) => new PlanLimitError(m, "seats"),
      limit === 1
        ? members + pending === 1
          ? msg("Your plan includes {limit} member and {taken} is taken by members and pending invitations. Revoke an invitation or upgrade the plan.")
          : msg("Your plan includes {limit} member and {taken} are taken by members and pending invitations. Revoke an invitation or upgrade the plan.")
        : members + pending === 1
          ? msg("Your plan includes {limit} members and {taken} is taken by members and pending invitations. Revoke an invitation or upgrade the plan.")
          : msg("Your plan includes {limit} members and {taken} are taken by members and pending invitations. Revoke an invitation or upgrade the plan."),
      { limit, taken: members + pending },
    );
}

/** Accepting an invitation needs a free seat among *members* (the invitation itself was counted when sent). */
export async function assertCanJoin(db: Db, organizationId: string): Promise<void> {
  await lockOrg(db, "org-members", organizationId);
  const limit = await planLimit(db, organizationId, "seats");
  if (limit === null) return;
  const { members } = await seatsUsed(db, organizationId);
  if (!canAdd(members, limit))
    throw new PlanLimitError(msg("This organization has no free seats on its plan. Ask an owner to upgrade the plan or remove a member."), "seats");
}

// ── Monthly events ──────────────────────────────────────────────────────────

export interface EventAllowance {
  /** null = unlimited. */
  limit: number | null;
  /** Usage from which requests are refused (limit + grace); null when unlimited. */
  hardCap: number | null;
  used: number;
  state: LimitState;
  periodStart: Date;
  periodEnd: Date;
}

interface CacheEntry {
  period: string;
  limit: number | null;
  used: number;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 50_000;
const ttlMs = () => envNumber("PLAN_USAGE_CACHE_MS", 30_000);

/** Forget cached allowances (all, or one organization's after a plan change). */
export function clearAllowanceCache(organizationId?: string) {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

async function loadAllowance(organizationId: string, start: Date, end: Date): Promise<{ limit: number | null; used: number }> {
  const row = await withSystem((db) =>
    db.one<{ value: unknown; used: string }>(
      `select (select f.value from platform.plan_features f where f.plan_id = o.plan_id and f.feature = $4) as value,
              (select coalesce(sum(r.quantity), 0) from platform.usage_records r
                where r.organization_id = o.id and r.meter_id = 'events' and r.day >= $2::date and r.day < $3::date) as used
         from platform.organizations o where o.id = $1`,
      [organizationId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), LIMIT_FEATURES.events],
    ),
  );
  return { limit: asLimit(row?.value), used: Number(row?.used ?? 0) };
}

/** This month's event allowance and usage for an organization, cached for a short window. */
export async function eventAllowance(organizationId: string, now = new Date(), opts: { fresh?: boolean } = {}): Promise<EventAllowance> {
  const { start, end, key } = usagePeriod(now);
  let entry = cache.get(organizationId);
  if (opts.fresh || !entry || entry.period !== key || Date.now() - entry.fetchedAt > ttlMs()) {
    const loaded = await loadAllowance(organizationId, start, end);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    entry = { period: key, ...loaded, fetchedAt: Date.now() };
    cache.set(organizationId, entry);
  }
  return {
    limit: entry.limit,
    hardCap: entry.limit === null ? null : eventHardCap(entry.limit),
    used: entry.used,
    state: eventState(entry.used, entry.limit),
    periodStart: start,
    periodEnd: end,
  };
}

/** Adds events this process just accepted to the cached usage, so the cap holds between refreshes. */
export function noteEventsAccepted(organizationId: string, count: number, now = new Date()) {
  const entry = cache.get(organizationId);
  if (entry && entry.period === usagePeriod(now).key) entry.used += count;
}
