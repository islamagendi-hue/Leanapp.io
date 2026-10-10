/**
 * Failed events in the debugger: an event whose processing failed for good is
 * listed (with a scrubbed error) and can be put back in the processing queue,
 * by people allowed to change the implementation only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { failedEvents, retryFailedEvents } from "@/modules/debugger/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;

async function send(events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const res = await ingest(sdk, { batch: events }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(events.length);
}

const row = (name: string) =>
  withSystem((db) =>
    db.one<{ processed_at: Date | null; processing_error: string | null; processing_attempts: number }>(
      "select processed_at, processing_error, processing_attempts from platform.events where environment_id = $1 and event_name = $2",
      [t.dev.id, name],
    ),
  );

async function poison(on: boolean) {
  await withSystem(async (db) => {
    if (on) {
      // A non-transient failure for one session only; the message carries a secret-looking value that must not reach the page.
      await db.query(`create or replace function platform.test_fail_event() returns trigger language plpgsql as $$
        begin
          if new.session_id = 'broken' then
            raise exception 'check failed token=la_sk_live_supersecretvalue123 for user someone@example.com' using errcode = '23514';
          end if;
          return new;
        end $$`);
      await db.query("create trigger test_fail_event before insert on platform.sessions for each row execute function platform.test_fail_event()");
    } else {
      await db.query("drop trigger if exists test_fail_event on platform.sessions");
      await db.query("drop function if exists platform.test_fail_event()");
    }
  });
}

beforeAll(async () => {
  t = await makeTenant("failed");
  other = await makeTenant("failed-other");
  await poison(true);
});

afterAll(async () => {
  await poison(false);
});

describe("failed events", () => {
  it("lists a permanently failed event with a scrubbed error, retries it, and it is processed once the cause is gone", async () => {
    await send([
      { type: "track", event_name: "fine_one", event_id: crypto.randomUUID(), anonymous_id: "f1", session_id: "ok" },
      { type: "track", event_name: "broken_one", event_id: crypto.randomUUID(), anonymous_id: "f1", session_id: "broken" },
    ]);
    // A non-transient error fails the event on the first attempt.
    expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 1, failed: 1 });
    expect((await row("broken_one"))?.processed_at).not.toBeNull();

    const before = await failedEvents(t.ctx, t.dev.id);
    expect(before.total).toBe(1);
    expect(before.events).toHaveLength(1);
    const ev = before.events[0];
    expect(ev).toMatchObject({ event_name: "broken_one", type: "track", attempts: 1 });
    expect(ev.error).toMatch(/check failed/);
    expect(ev.error).not.toMatch(/supersecretvalue|someone@example\.com/);
    expect(ev.error.length).toBeLessThanOrEqual(200);

    // Other tenants and other environments see nothing.
    expect((await failedEvents(other.ctx, t.dev.id)).total).toBe(0);
    const prod = t.environments.find((e) => e.type === "production")!;
    expect((await failedEvents(t.ctx, prod.id)).total).toBe(0);
    await expect(retryFailedEvents(other.ctx, t.dev.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(retryFailedEvents(t.ctx, t.dev.id, "999999999")).rejects.toBeInstanceOf(NotFoundError);

    // Retrying while the cause is still there: it fails again and stays listed.
    expect(await retryFailedEvents(t.ctx, t.dev.id, ev.id)).toEqual({ retried: 1 });
    expect(await row("broken_one")).toEqual({ processed_at: null, processing_error: null, processing_attempts: 0 });
    expect((await failedEvents(t.ctx, t.dev.id)).total).toBe(0);
    expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 0, failed: 1 });
    expect((await failedEvents(t.ctx, t.dev.id)).total).toBe(1);

    // Cause removed: "retry all" puts it back, and it is processed and counted.
    await poison(false);
    expect(await retryFailedEvents(t.ctx, t.dev.id)).toEqual({ retried: 1 });
    expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 1, failed: 0 });
    const done = await row("broken_one");
    expect(done?.processed_at).not.toBeNull();
    expect(done?.processing_error).toBeNull();
    expect((await failedEvents(t.ctx, t.dev.id)).total).toBe(0);
    const session = await withSystem((db) =>
      db.one<{ event_count: number }>("select event_count from platform.sessions where environment_id = $1 and session_id = 'broken'", [t.dev.id]),
    );
    expect(Number(session?.event_count)).toBe(1);

    // Nothing left: retry is a no-op. Each retry that changed something is audited.
    expect(await retryFailedEvents(t.ctx, t.dev.id)).toEqual({ retried: 0 });
    const audits = await withSystem((db) =>
      db.query<{ metadata: Record<string, unknown> }>(
        "select metadata from platform.audit_logs where organization_id = $1 and action = 'events.retried' and target_id = $2 order by id",
        [t.org.id, t.dev.id],
      ),
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ count: 1, event_id: ev.id }, { count: 1 }]);
  });

  it("requires implementation.edit to retry; events.read is enough to look", async () => {
    for (const role of ["analyst", "marketer", "viewer"] as const) {
      const ctx: TenantContext = { ...t.ctx, role };
      await expect(retryFailedEvents(ctx, t.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(failedEvents({ ...t.ctx, role: "analyst" }, t.dev.id)).resolves.toMatchObject({ total: 0 });
    await expect(failedEvents({ ...t.ctx, role: "viewer" }, t.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ["developer", "admin"] as const) {
      await expect(retryFailedEvents({ ...t.ctx, role }, t.dev.id)).resolves.toEqual({ retried: 0 });
    }
  });
});
