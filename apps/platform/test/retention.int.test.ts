/**
 * Scheduled cleanup: operational purges, and plan retention that only deletes
 * customer events when enforcement is switched on.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { sendVerificationEmail } from "@/modules/auth/account";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { applyEventRetention, purgeOperationalData, retentionMode } from "@/modules/maintenance/retention";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let free: T;
let paid: T;

const q = <R extends Record<string, unknown>>(sql: string, values: unknown[] = []) => withSystem((db) => db.query<R>(sql, values));
const n = async (sql: string, values: unknown[]) => Number((await q<{ n: string }>(sql, values))[0].n);

async function seed(t: T) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const batch = ["s-old", "s-old", "s-new"].map((s) => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), anonymous_id: "a1", session_id: s }));
  await ingest(sdk, { batch }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
  // Age two events and their session past 30 days (the free plan's retention).
  await q("update platform.events set received_at = now() - interval '45 days' where environment_id = $1 and session_id = 's-old'", [t.dev.id]);
  await q("update platform.sessions set started_at = now() - interval '45 days', ended_at = now() - interval '45 days' where environment_id = $1 and session_id = 's-old'", [t.dev.id]);
}

beforeAll(async () => {
  free = await makeTenant("ret-free");
  paid = await makeTenant("ret-paid");
  await q(
    "insert into platform.subscriptions (organization_id, plan_id, status, current_period_start, current_period_end) values ($1, 'growth', 'active', now(), now() + interval '1 month')",
    [paid.org.id],
  );
  await seed(free);
  await seed(paid);
});

describe("plan retention", () => {
  it("defaults to reporting, never deleting", async () => {
    expect(retentionMode()).toBe("report");
    const r = await applyEventRetention({ organizationIds: [free.org.id, paid.org.id] });
    expect(r.mode).toBe("report");
    expect(r.organizations).toEqual([{ organizationId: free.org.id, retentionDays: 30, events: 2, sessions: 1 }]);
    expect(await n("select count(*) as n from platform.events where environment_id = $1", [free.dev.id])).toBe(3);
  });

  it("deletes past-retention events and sessions when enforced, per plan", async () => {
    const r = await applyEventRetention({ mode: "enforce", organizationIds: [free.org.id, paid.org.id] });
    expect(r.organizations).toEqual([{ organizationId: free.org.id, retentionDays: 30, events: 2, sessions: 1 }]);
    expect(await n("select count(*) as n from platform.events where environment_id = $1", [free.dev.id])).toBe(1);
    expect(await n("select count(*) as n from platform.sessions where environment_id = $1", [free.dev.id])).toBe(1);
    // Growth keeps 365 days.
    expect(await n("select count(*) as n from platform.events where environment_id = $1", [paid.dev.id])).toBe(3);
  });

  it("works through large backlogs in batches", async () => {
    await q("update platform.events set received_at = now() - interval '400 days' where environment_id = $1", [paid.dev.id]);
    const first = await applyEventRetention({ mode: "enforce", batch: 2, organizationIds: [paid.org.id] });
    expect(first.organizations[0].events).toBe(2);
    const second = await applyEventRetention({ mode: "enforce", batch: 2, organizationIds: [paid.org.id] });
    expect(second.organizations[0].events).toBe(1);
    expect((await applyEventRetention({ mode: "enforce", organizationIds: [paid.org.id] })).organizations).toEqual([]);
  });
});

describe("operational purge", () => {
  it("removes only expired tokens, sessions and invitations and old logs", async () => {
    await sendVerificationEmail(free.user.id); // a live token
    await sendVerificationEmail(free.user.id); // supersedes it: the first is now used
    await q("update platform.auth_tokens set used_at = now() - interval '2 days' where user_id = $1 and used_at is not null", [free.user.id]);
    await q("update platform.auth_sessions set revoked_at = now() - interval '40 days' where user_id = $1", [paid.user.id]);
    await q("update platform.event_batches set received_at = now() - interval '40 days' where environment_id = $1", [free.dev.id]);

    const r = await purgeOperationalData();
    expect(r.auth_tokens).toBeGreaterThanOrEqual(1);
    expect(r.auth_sessions).toBeGreaterThanOrEqual(1);
    expect(r.event_batches).toBeGreaterThanOrEqual(1);
    expect(await n("select count(*) as n from platform.auth_tokens where user_id = $1 and used_at is null", [free.user.id])).toBe(1);
    expect(await n("select count(*) as n from platform.auth_sessions where user_id = $1", [free.user.id])).toBeGreaterThanOrEqual(1);
  });
});
