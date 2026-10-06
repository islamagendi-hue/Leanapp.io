import "server-only";
import type { Db } from "@/lib/db";

/**
 * Messaging consent, as far as the data model records it today: the latest
 * consent_records row per purpose for the person, and marketing opt-out
 * privacy requests. There is no consent capture API yet, so the rule is
 * opt-out based: email and push are skipped for anyone with a recorded
 * opt-out ("marketing" for both channels, "push" for push), and sent
 * otherwise. See docs/automation.md.
 */
export type Channel = "push" | "email";

export function splitUserKey(userKey: string): { userId: string | null; anonymousId: string | null } {
  return userKey.startsWith("anon:") ? { userId: null, anonymousId: userKey.slice(5) } : { userId: userKey, anonymousId: null };
}

/** Returns why the person may not receive this channel, or null when they may. */
export async function messagingBlocked(db: Db, environmentId: string, userKey: string, channel: Channel): Promise<string | null> {
  const purposes = channel === "push" ? ["marketing", "push"] : ["marketing"];
  const { userId, anonymousId } = splitUserKey(userKey);
  const row = await db.one<{ revoked: boolean; opt_out_request: boolean }>(
    `select exists (
              select 1 from (
                select distinct on (purpose) purpose, granted from platform.consent_records
                 where environment_id = $1 and user_key = $2 and purpose = any($3)
                 order by purpose, recorded_at desc, id) latest
               where not granted) as revoked,
            exists (
              select 1 from platform.privacy_requests
               where environment_id = $1 and kind = 'marketing_opt_out' and status <> 'rejected'
                 and (subject_user_id = $4 or subject_anonymous_id = $5)) as opt_out_request`,
    [environmentId, userKey, purposes, userId, anonymousId],
  );
  if (row?.revoked) return "consent_revoked";
  if (row?.opt_out_request) return "marketing_opt_out";
  return null;
}
