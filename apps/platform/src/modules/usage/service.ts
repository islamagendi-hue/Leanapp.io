import "server-only";
import type { Db } from "@/lib/db";
import { PERSON } from "@/modules/analytics/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

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

/**
 * Monthly active users are counted from the event stream, not a counter, so they
 * are reproducible. People are stitched like analytics: an install linked to one
 * user counts as that user, not as an extra anonymous person.
 */
export async function monthlyActiveUsers(db: Db, environmentIds: string[], monthStart: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `select count(distinct ${PERSON.expr}) as n
       from platform.events e
       ${PERSON.join}
      where e.environment_id = any($1) and e."timestamp" >= $2 and e."timestamp" < ($2::timestamptz + interval '1 month')
        and coalesce(e.user_id, e.anonymous_id) is not null`,
    [environmentIds, monthStart],
  );
  return Number(row?.n ?? 0);
}

export interface UsageLine {
  key: "events" | "apps" | "seats" | "monthly_active_users";
  label: string;
  used: number;
  /** null = unlimited on this plan. */
  limit: number | null;
}

export interface UsageSummary {
  plan: { id: string; name: string; retentionDays: number | null };
  periodStart: Date;
  lines: UsageLine[];
}

/**
 * This calendar month's usage (UTC) against the organization's plan. Limits are
 * shown, not enforced: nothing is blocked when usage goes over.
 */
export function usageSummary(ctx: TenantContext, now = new Date()): Promise<UsageSummary> {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return tenantTx(ctx, "billing.read", async (db) => {
    const plan = await db.one<{ id: string; name: string }>(
      "select p.id, p.name from platform.organizations o join platform.plans p on p.id = o.plan_id where o.id = $1",
      [ctx.organizationId],
    );
    const features = await db.query<{ feature: string; value: number | null }>(
      "select feature, value from platform.plan_features where plan_id = $1",
      [plan!.id],
    );
    const limit = (f: string) => {
      const v = features.find((x) => x.feature === f)?.value;
      return typeof v === "number" ? v : null;
    };
    const events = await db.one<{ n: string }>(
      "select coalesce(sum(quantity), 0) as n from platform.usage_records where meter_id = 'events' and day >= $1::date",
      [periodStart.toISOString().slice(0, 10)],
    );
    const apps = await db.one<{ n: string }>("select count(*) as n from platform.apps where status = 'active'");
    const seats = await db.one<{ n: string }>("select count(*) as n from platform.organization_members");
    const prodEnvs = await db.query<{ id: string }>("select id from platform.environments where type = 'production'");
    const mau = prodEnvs.length ? await monthlyActiveUsers(db, prodEnvs.map((e) => e.id), periodStart) : 0;
    return {
      plan: { id: plan!.id, name: plan!.name, retentionDays: limit("retention.days") },
      periodStart,
      lines: [
        { key: "events", label: "Events this month", used: Number(events!.n), limit: limit("limit.events_per_month") },
        { key: "monthly_active_users", label: "Monthly active users (production)", used: mau, limit: null },
        { key: "apps", label: "Apps", used: Number(apps!.n), limit: limit("limit.apps") },
        { key: "seats", label: "Members", used: Number(seats!.n), limit: limit("limit.seats") },
      ],
    };
  });
}
