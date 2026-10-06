import "server-only";
import { withSystem } from "@/lib/db";
import { log } from "@/lib/log";
import { sendEmail } from "@/modules/email/service";
import { usageNoticeMessage } from "@/modules/email/templates";
import { publicAppUrl } from "@/server/env";
import { LIMIT_FEATURES, thresholdsReached, usagePeriod, type NoticeThreshold } from "./limits";

/**
 * Scheduled: emails owners when an organization's monthly events reach 80%,
 * 100% and 110% (refusing) of its plan, once per threshold per period. A row
 * in usage_notices is the "once": it is inserted (on conflict do nothing) in
 * the same transaction that sends, and only the highest new threshold is
 * emailed, so an organization that jumps straight past 100% gets one email.
 *
 * Bounded (`limit` organizations per run) and safe to run concurrently: a
 * second run skips while another holds the advisory lock.
 */
export async function sendUsageNotices(opts: { now?: Date; limit?: number } = {}): Promise<{ notices: number; emails: number; skipped?: boolean }> {
  const now = opts.now ?? new Date();
  const { end, key } = usagePeriod(now);
  return withSystem(async (db) => {
    const lock = await db.one<{ ok: boolean }>("select pg_try_advisory_xact_lock(hashtextextended('billing-usage-notices', 0)) as ok");
    if (!lock?.ok) return { notices: 0, emails: 0, skipped: true };
    const rows = await db.query<{ id: string; name: string; slug: string; used: string; lim: string }>(
      `with usage as (
         select organization_id, sum(quantity) as used from platform.usage_records
          where meter_id = 'events' and day >= $1::date and day < $2::date group by organization_id)
       select o.id, o.name, o.slug, u.used, (f.value #>> '{}')::bigint as lim
         from usage u
         join platform.organizations o on o.id = u.organization_id and o.status = 'active'
         join platform.plan_features f on f.plan_id = o.plan_id and f.feature = $3 and jsonb_typeof(f.value) = 'number'
        where u.used >= 0.8 * (f.value #>> '{}')::numeric
          and not exists (select 1 from platform.usage_notices n
                           where n.organization_id = o.id and n.period_start = $1::date and n.limit_key = 'events' and n.threshold = 110)
        order by o.id limit $4`,
      [key, end.toISOString().slice(0, 10), LIMIT_FEATURES.events, opts.limit ?? 200],
    );
    let notices = 0;
    let emails = 0;
    for (const org of rows) {
      const used = Number(org.used);
      const limit = Number(org.lim);
      const fresh: NoticeThreshold[] = [];
      for (const t of thresholdsReached(used, limit)) {
        const ins = await db.one(
          `insert into platform.usage_notices (organization_id, period_start, limit_key, threshold, used, limit_value)
           values ($1, $2, 'events', $3, $4, $5) on conflict do nothing returning threshold`,
          [org.id, key, t, used, limit],
        );
        if (ins) fresh.push(t);
      }
      if (!fresh.length) continue;
      notices += fresh.length;
      const top = fresh[fresh.length - 1];
      const owners = await db.query<{ email: string }>(
        `select u.email from platform.organization_members m join platform.users u on u.id = m.user_id
          where m.organization_id = $1 and m.role_id = 'owner' and u.status = 'active'`,
        [org.id],
      );
      let delivered = 0;
      for (const o of owners) {
        const r = await sendEmail(usageNoticeMessage(o.email, org.name, top, used, limit, end.toISOString().slice(0, 10), `${publicAppUrl()}/o/${org.slug}/settings/billing`));
        if (r.delivered) delivered++;
      }
      emails += delivered;
      await db.query(
        "update platform.usage_notices set recipients = $4, delivered = $5 where organization_id = $1 and period_start = $2 and limit_key = 'events' and threshold = $3",
        [org.id, key, top, owners.length, delivered],
      );
      log.info("billing.usage_notice", { organization_id: org.id, threshold: top, recipients: owners.length, delivered });
    }
    return { notices, emails };
  });
}
