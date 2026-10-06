import "server-only";
import { withSystem } from "@/lib/db";
import { recomputeDueAudiences } from "@/modules/audiences/service";
import { deliverWebhooks } from "@/modules/webhooks/service";
import { enqueueTriggers, stepRuns } from "./engine";

/**
 * The engagement part of the scheduled worker, in dependency order: audiences
 * (membership transitions) → triggers (new runs) → steps (messages, webhook
 * deliveries queued) → webhook deliveries → housekeeping. Each stage is
 * bounded and safe to run concurrently with another worker; whatever doesn't
 * fit before `deadline` waits for the next run.
 */
export async function runEngagement(opts: { deadline: number }): Promise<Record<string, unknown>> {
  const left = () => Date.now() < opts.deadline;
  const out: Record<string, unknown> = {};
  if (left()) out.audiences = await recomputeDueAudiences({ limit: 20, deadline: opts.deadline });
  if (left()) out.triggers = await enqueueTriggers({ deadline: opts.deadline });
  if (left()) out.runs = await stepRuns({ limit: 200, deadline: opts.deadline });
  if (left()) out.webhooks = (await deliverWebhooks({ limit: 200, deadline: opts.deadline })).length;
  if (left()) out.purged = await purgeEngagementData();
  return out;
}

/** Operational engagement rows nothing reads after these windows. */
export async function purgeEngagementData(): Promise<Record<string, number>> {
  const steps = {
    in_app_expired: "update platform.in_app_messages set status = 'expired' where status in ('pending', 'displayed') and expires_at < now()",
    webhook_deliveries: "delete from platform.webhook_deliveries where status <> 'pending' and created_at < now() - interval '30 days'",
    audience_snapshots: "delete from platform.audience_snapshots where computed_at < now() - interval '90 days'",
    audience_events: "delete from platform.audience_events where occurred_at < now() - interval '90 days'",
  };
  const out: Record<string, number> = {};
  for (const [label, sql] of Object.entries(steps)) {
    const rows = await withSystem((db) => db.query(`with d as (${sql} returning 1) select count(*)::int as n from d`));
    out[label] = (rows[0] as { n: number }).n;
  }
  return out;
}
