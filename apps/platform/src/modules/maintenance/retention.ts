import "server-only";
import { withSystem, withTenant } from "@/lib/db";

/**
 * Scheduled cleanup, run by the cron worker.
 *
 * Operational data (expired tokens and sessions, old request logs) is purged
 * unconditionally: nothing reads it after these windows.
 *
 * Customer event data is different: deleting it is irreversible, so plan
 * retention (`plan_features` "retention.days") is only *enforced* when
 * EVENT_RETENTION=enforce. Otherwise the job reports what it would delete.
 */

/** Windows after which operational rows are useless. */
const OPERATIONAL = [
  { label: "auth_tokens", sql: "delete from platform.auth_tokens where coalesce(used_at, expires_at) < now() - interval '1 day'" },
  { label: "auth_sessions", sql: "delete from platform.auth_sessions where coalesce(revoked_at, expires_at) < now() - interval '30 days'" },
  {
    label: "invitations",
    sql: "delete from platform.organization_invitations where accepted_at is null and coalesce(revoked_at, expires_at) < now() - interval '30 days'",
  },
  // Idempotency replays and the debugger's "rejected today" only look back hours; 30 days leaves room for support questions.
  { label: "event_batches", sql: "delete from platform.event_batches where received_at < now() - interval '30 days'" },
  { label: "api_request_logs", sql: "delete from platform.api_request_logs where created_at < now() - interval '30 days'" },
] as const;

export async function purgeOperationalData(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const step of OPERATIONAL) {
    const rows = await withSystem((db) => db.query(`with d as (${step.sql} returning 1) select count(*)::int as n from d`));
    out[step.label] = (rows[0] as { n: number }).n;
  }
  return out;
}

export type RetentionMode = "enforce" | "report";

export function retentionMode(): RetentionMode {
  return process.env.EVENT_RETENTION === "enforce" ? "enforce" : "report";
}

export interface RetentionResult {
  mode: RetentionMode;
  organizations: { organizationId: string; retentionDays: number; events: number; sessions: number }[];
}

/**
 * Applies each organization's plan retention to events and sessions. In
 * "report" mode it counts what is past retention; in "enforce" mode it deletes
 * up to `batch` rows per table per organization per run (the next run continues).
 * Organizations without a subscription are on the free plan.
 */
export async function applyEventRetention(opts: { mode?: RetentionMode; batch?: number; organizationIds?: string[] } = {}): Promise<RetentionResult> {
  const mode = opts.mode ?? retentionMode();
  const batch = opts.batch ?? 10_000;
  const orgs = await withSystem((db) =>
    db.query<{ id: string; days: number }>(
      `select o.id, (pf.value #>> '{}')::int as days
         from platform.organizations o
         left join lateral (
           select plan_id from platform.subscriptions s
            where s.organization_id = o.id and s.status in ('trialing', 'active', 'past_due')
            order by s.created_at desc limit 1) s on true
         join platform.plan_features pf on pf.plan_id = coalesce(s.plan_id, 'free') and pf.feature = 'retention.days'
        where (pf.value #>> '{}') is not null
          and ($1::uuid[] is null or o.id = any($1))`,
      [opts.organizationIds ?? null],
    ),
  );
  const result: RetentionResult = { mode, organizations: [] };
  for (const org of orgs) {
    // Under the organization's RLS scope; `environments` resolves to its own, so the (environment_id, time) indexes apply.
    const counts = await withTenant({ organizationId: org.id, userId: null }, async (db) => {
      const cutoff = `now() - make_interval(days => $1)`;
      if (mode === "report") {
        const e = await db.one<{ n: number }>(`select count(*)::int as n from platform.events where environment_id in (select id from platform.environments) and received_at < ${cutoff}`, [org.days]);
        const s = await db.one<{ n: number }>(`select count(*)::int as n from platform.sessions where environment_id in (select id from platform.environments) and started_at < ${cutoff}`, [org.days]);
        return { events: e!.n, sessions: s!.n };
      }
      const e = await db.one<{ n: number }>(
        `with d as (delete from platform.events where id in (select id from platform.events where environment_id in (select id from platform.environments) and received_at < ${cutoff} limit $2) returning 1)
         select count(*)::int as n from d`,
        [org.days, batch],
      );
      const s = await db.one<{ n: number }>(
        `with d as (delete from platform.sessions where id in (select id from platform.sessions where environment_id in (select id from platform.environments) and started_at < ${cutoff} limit $2) returning 1)
         select count(*)::int as n from d`,
        [org.days, batch],
      );
      return { events: e!.n, sessions: s!.n };
    });
    if (counts.events || counts.sessions) result.organizations.push({ organizationId: org.id, retentionDays: org.days, ...counts });
  }
  return result;
}
