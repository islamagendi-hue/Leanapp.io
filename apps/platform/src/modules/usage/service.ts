import "server-only";
import type { Db } from "@/lib/db";

export type UsageMetric = "events" | "monthly_active_users" | "automation_runs" | "push_messages" | "api_requests" | "storage" | "seats";

/**
 * UsageService.record(organizationId, metric, quantity): the single entry point
 * for metering. Writes a daily rollup inside the caller's transaction so usage
 * is counted exactly when the work commits. Pricing and limits read these rows
 * together with platform.plan_features (data, not code).
 */
export async function recordUsage(db: Db, organizationId: string, metric: UsageMetric, quantity: number, at = new Date()): Promise<void> {
  if (!quantity) return;
  await db.query(
    `insert into platform.usage_records (organization_id, meter_id, day, quantity) values ($1, $2, ($3::timestamptz at time zone 'UTC')::date, $4)
     on conflict (organization_id, meter_id, day) do update set quantity = platform.usage_records.quantity + excluded.quantity, updated_at = now()`,
    [organizationId, metric, at, quantity],
  );
}

/** Monthly active users are counted from the event stream, not a counter, so they are reproducible. */
export async function monthlyActiveUsers(db: Db, environmentIds: string[], monthStart: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `select count(distinct coalesce(user_id, 'anon:' || anonymous_id)) as n
       from platform.events
      where environment_id = any($1) and "timestamp" >= $2 and "timestamp" < ($2::timestamptz + interval '1 month')`,
    [environmentIds, monthStart],
  );
  return Number(row?.n ?? 0);
}
