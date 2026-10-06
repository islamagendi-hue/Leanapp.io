/**
 * Event processing under concurrency: workers racing over the same
 * environments never deadlock or drop events, and transient failures are
 * retried a bounded number of times.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, listKeys } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { MAX_PROCESSING_ATTEMPTS, processPendingEvents, recomputeImplementation } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;

async function send(environmentId: string, events: Record<string, unknown>[]) {
  const keys = await listKeys(t.ctx, t.app.id);
  const sdk = (await authenticateIngestionKey(keys.sdkKeys.find((k) => k.environment_id === environmentId)!.key))!;
  for (let i = 0; i < events.length; i += 50) {
    const res = await ingest(sdk, { batch: events.slice(i, i + 50) }, { mode: "batch" });
    expect((res.body as { accepted: number }).accepted).toBe(events.slice(i, i + 50).length);
  }
}

beforeAll(async () => {
  t = await makeTenant("processing");
});

describe("concurrent processing", () => {
  it("processes interleaved events from racing workers without errors", async () => {
    const envs = t.environments.slice(0, 2);
    const perEnv = 300;
    for (const env of envs) {
      // Events touch the same users, sessions and status rows in alternating
      // orders: exactly the pattern that deadlocked unserialized workers.
      const events = Array.from({ length: perEnv }, (_, i) => {
        const k = i % 2 ? i % 7 : 6 - (i % 7);
        return {
          type: "track", event_name: `step_${i % 5}`, event_id: crypto.randomUUID(),
          anonymous_id: `a${k}`, user_id: `u${k}`, session_id: `s${(i * 3) % 7}`,
        };
      });
      await send(env.id, events);
    }

    // Several workers each draining in small slices, so their batches interleave.
    const pending = async () =>
      Number((await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.events where processed_at is null and app_id = $1", [t.app.id])))?.n);
    const drain = async (opts: { environmentId?: string }) => {
      const total = { processed: 0, failed: 0 };
      for (let i = 0; i < 200 && (await pending()) > 0; i++) {
        const r = await processPendingEvents({ ...opts, limit: 40 });
        total.processed += r.processed;
        total.failed += r.failed;
      }
      return total;
    };
    const results = await Promise.all([drain({}), drain({}), drain({}), drain({ environmentId: envs[0].id }), drain({ environmentId: envs[1].id })]);
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
    expect(results.reduce((n, r) => n + r.processed, 0)).toBe(perEnv * envs.length);

    for (const env of envs) {
      const row = await withSystem((db) =>
        db.one<{ pending: string; errors: string }>(
          "select count(*) filter (where processed_at is null) as pending, count(processing_error) as errors from platform.events where environment_id = $1",
          [env.id],
        ),
      );
      expect(row).toEqual({ pending: "0", errors: "0" });
      const sessions = await withSystem((db) =>
        db.one<{ n: string }>("select sum(event_count) as n from platform.sessions where environment_id = $1", [env.id]),
      );
      expect(Number(sessions?.n)).toBe(perEnv);
      const status = await withSystem((db) =>
        db.one<{ n: string }>("select sum(received_count) as n from platform.tracking_implementation_status where environment_id = $1", [env.id]),
      );
      expect(Number(status?.n)).toBe(perEnv);
    }
  });

  it("retries transient failures, then gives up on a poison event", async () => {
    // A trigger that fails like a deadlock for one session only.
    await withSystem(async (db) => {
      await db.query(`create function platform.test_poison() returns trigger language plpgsql as $$
        begin
          if new.session_id = 'poison' then raise exception 'deadlock detected' using errcode = '40P01'; end if;
          return new;
        end $$`);
      await db.query("create trigger test_poison before insert on platform.sessions for each row execute function platform.test_poison()");
    });
    try {
      await send(t.dev.id, [
        { type: "track", event_name: "ok_before", event_id: crypto.randomUUID(), anonymous_id: "p1", session_id: "fine" },
        { type: "track", event_name: "bad", event_id: crypto.randomUUID(), anonymous_id: "p1", session_id: "poison" },
        { type: "track", event_name: "ok_after", event_id: crypto.randomUUID(), anonymous_id: "p1", session_id: "fine" },
      ]);
      // Left pending for the next run, attempt after attempt, then marked failed.
      expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 2, failed: 0 });
      for (let i = 2; i < MAX_PROCESSING_ATTEMPTS; i++) {
        expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 0, failed: 0 });
      }
      expect(await processPendingEvents({ environmentId: t.dev.id })).toEqual({ processed: 0, failed: 1 });
      const bad = await withSystem((db) =>
        db.one<{ processed_at: Date | null; processing_attempts: number; processing_error: string }>(
          "select processed_at, processing_attempts, processing_error from platform.events where environment_id = $1 and event_name = 'bad'",
          [t.dev.id],
        ),
      );
      expect(bad?.processed_at).not.toBeNull();
      expect(bad?.processing_attempts).toBe(MAX_PROCESSING_ATTEMPTS);
      expect(bad?.processing_error).toMatch(/deadlock/);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger test_poison on platform.sessions");
        await db.query("drop function platform.test_poison()");
      });
    }
  });
});

describe("recompute", () => {
  it("re-keys mapped names without losing lifetime counters", async () => {
    const env = t.environments[0];
    const status = () =>
      withSystem((db) =>
        db.query<{ event_name: string; received_count: string; first_received_at: Date }>(
          "select event_name, received_count, first_received_at from platform.tracking_implementation_status where environment_id = $1 and event_name like 'step_%' order by event_name",
          [env.id],
        ),
      );
    const before = await status();
    expect(before.map((r) => Number(r.received_count))).toEqual([60, 60, 60, 60, 60]);
    // Half the history falls outside the recompute window.
    await withSystem(async (db) => {
      await db.query("update platform.events set received_at = now() - interval '60 days' where environment_id = $1 and id % 2 = 0", [env.id]);
      await db.query(
        "insert into platform.event_mappings (organization_id, app_id, from_name, to_name, status) values ($1, $2, 'step_4', 'step_3', 'accepted')",
        [t.org.id, t.app.id],
      );
    });
    await withSystem((db) => recomputeImplementation(db, t.app.id));
    const after = await status();
    expect(after.map((r) => [r.event_name, Number(r.received_count)])).toEqual([["step_0", 60], ["step_1", 60], ["step_2", 60], ["step_3", 120]]);
    expect(after[0].first_received_at).toEqual(before[0].first_received_at);
    const canonical = await withSystem((db) =>
      db.one<{ mapped: string; old: string }>(
        `select count(*) filter (where canonical_name = 'step_3' and received_at > now() - interval '30 days') as mapped,
                count(*) filter (where canonical_name is null and received_at < now() - interval '30 days') as old
           from platform.events where environment_id = $1 and event_name = 'step_4'`,
        [env.id],
      ),
    );
    expect(Number(canonical?.mapped)).toBeGreaterThan(0);
    expect(Number(canonical?.old)).toBeGreaterThan(0); // outside the window: left as is
  });
});
