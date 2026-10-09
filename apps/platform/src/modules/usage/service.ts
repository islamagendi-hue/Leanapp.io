import "server-only";
import type { Db } from "@/lib/db";
import { COUNTED_EVENTS, PERSON } from "@/modules/analytics/sql";
import { seatsUsed } from "@/modules/billing/enforcement";
import { asLimit, countState, eventHardCap, eventState, LIMIT_FEATURES, usagePeriod, type LimitState } from "@/modules/billing/limits";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

export type UsageMetric = "events" | "events_refused" | "monthly_active_users" | "automation_runs" | "push_messages" | "whatsapp_messages" | "email_messages" | "api_requests" | "storage" | "seats";

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
 * are reproducible. They follow the analytics rules exactly, so billed MAU is
 * the "active people" a report shows for the same window:
 *
 * - only counted events (COUNTED_EVENTS: processed track events and screen
 *   views); identify, alias, push_token, consent and events that are still
 *   unprocessed or failed processing make nobody active;
 * - people are stitched like analytics (PERSON): an install linked to one user
 *   counts as that user, not as an extra anonymous person.
 *
 * The month is a calendar month in UTC (billing periods), while reports use
 * the app's timezone, so a report over "this month" can differ at the edges.
 */
export async function monthlyActiveUsers(db: Db, environmentIds: string[], monthStart: Date): Promise<number> {
  const row = await db.one<{ n: string }>(
    `select count(distinct ${PERSON.expr}) as n
       from platform.events e
       ${PERSON.join}
      where e.environment_id = any($1) and e."timestamp" >= $2 and e."timestamp" < ($2::timestamptz + interval '1 month')
        and coalesce(e.user_id, e.anonymous_id) is not null and ${COUNTED_EVENTS}`,
    [environmentIds, monthStart],
  );
  return Number(row?.n ?? 0);
}

export interface UsageLine {
  key: "events" | "apps" | "seats" | "monthly_active_users";
  label: string;
  used: number;
  /** null = unlimited on this plan (or not a limit). */
  limit: number | null;
  /** warning from 80%, over from 100%, blocked when ingestion refuses (events past the grace). */
  state: LimitState;
  /** Events only: usage from which ingestion refuses (limit + 10% grace). */
  hardCap?: number | null;
  note?: string;
}

export interface UsageSummary {
  plan: { id: string; name: string; retentionDays: number | null };
  periodStart: Date;
  periodEnd: Date;
  lines: UsageLine[];
  /** Events refused this month because the allowance (with grace) was used up. */
  eventsRefused: number;
}

/**
 * This calendar month's usage (UTC) against the organization's plan. Apps and
 * members (including pending invitations) are hard limits checked when one is
 * added; monthly events are a soft limit with a 10% grace, then ingestion
 * refuses (modules/billing).
 */
export function usageSummary(ctx: TenantContext, now = new Date()): Promise<UsageSummary> {
  const { start: periodStart, end: periodEnd } = usagePeriod(now);
  return tenantTx(ctx, "billing.read", async (db) => {
    const plan = await db.one<{ id: string; name: string }>(
      "select p.id, p.name from platform.organizations o join platform.plans p on p.id = o.plan_id where o.id = $1",
      [ctx.organizationId],
    );
    const features = await db.query<{ feature: string; value: unknown }>(
      "select feature, value from platform.plan_features where plan_id = $1",
      [plan!.id],
    );
    const limit = (f: string) => asLimit(features.find((x) => x.feature === f)?.value);
    const meters = await db.query<{ meter_id: string; n: string }>(
      `select meter_id, coalesce(sum(quantity), 0) as n from platform.usage_records
        where meter_id in ('events', 'events_refused') and day >= $1::date and day < $2::date group by meter_id`,
      [periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10)],
    );
    const meter = (id: string) => Number(meters.find((m) => m.meter_id === id)?.n ?? 0);
    const apps = await db.one<{ n: string }>("select count(*) as n from platform.apps where status = 'active'");
    const seats = await seatsUsed(db, ctx.organizationId);
    const prodEnvs = await db.query<{ id: string }>("select id from platform.environments where type = 'production'");
    const mau = prodEnvs.length ? await monthlyActiveUsers(db, prodEnvs.map((e) => e.id), periodStart) : 0;
    const eventsLimit = limit(LIMIT_FEATURES.events);
    const appsLimit = limit(LIMIT_FEATURES.apps);
    const seatsLimit = limit(LIMIT_FEATURES.seats);
    const events = meter("events");
    const seatCount = seats.members + seats.pending;
    return {
      plan: { id: plan!.id, name: plan!.name, retentionDays: limit("retention.days") },
      periodStart,
      periodEnd,
      eventsRefused: meter("events_refused"),
      lines: [
        { key: "events", label: "Events this month", used: events, limit: eventsLimit, state: eventState(events, eventsLimit), hardCap: eventsLimit === null ? null : eventHardCap(eventsLimit) },
        { key: "monthly_active_users", label: "Monthly active users (production)", used: mau, limit: null, state: "ok" },
        { key: "apps", label: "Apps", used: Number(apps!.n), limit: appsLimit, state: countState(Number(apps!.n), appsLimit) },
        {
          key: "seats", label: "Members", used: seatCount, limit: seatsLimit, state: countState(seatCount, seatsLimit),
          note: seats.pending ? `${seats.members} member${seats.members === 1 ? "" : "s"} and ${seats.pending} pending invitation${seats.pending === 1 ? "" : "s"}` : undefined,
        },
      ],
    };
  });
}
