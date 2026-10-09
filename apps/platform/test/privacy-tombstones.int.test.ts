/**
 * Privacy tombstones: after a deletion, events of the deleted user (and the
 * deleted install's anonymous events) still queued in an SDK or sent later by a
 * backend are dropped at ingestion with reason `subject_deleted`; nothing else
 * changes, in this or any other environment or organization.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { authenticateIngestionKey, createApiKey, listKeys, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest, type IngestResponse } from "@/modules/ingestion/service";
import { requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { lockTombstonesShared, tombstoneHash, waitForIngestion } from "@/modules/privacy/tombstones";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;
let server: IngestionPrincipal;
let prodSdk: IngestionPrincipal;
let otherSdk: IngestionPrincipal;

const ev = (o: Record<string, unknown>) => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), ...o });

async function count(sql: string, values: unknown[]) {
  const row = await withSystem((db) => db.one<{ n: string }>(sql, values));
  return Number(row!.n);
}
const eventsWhere = (env: string, where: string) => count(`select count(*) as n from platform.events where environment_id = $1 and ${where}`, [env]);

// The same people in every environment and organization: a1 is u1's phone, a2 is u2's.
const seed = () => [
  ev({ type: "identify", anonymous_id: "a1", user_id: "u1" }),
  ev({ anonymous_id: "a1" }),
  ev({ anonymous_id: "a1", user_id: "u1" }),
  ev({ type: "identify", anonymous_id: "a2", user_id: "u2" }),
  ev({ anonymous_id: "a2", user_id: "u2" }),
];

beforeAll(async () => {
  t = await makeTenant("tomb");
  other = await makeTenant("tomb-other");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;
  server = (await authenticateIngestionKey((await createApiKey(t.ctx, t.dev.id, { label: "server" })).key))!;
  const prod = t.environments.find((e) => e.type === "production")!;
  prodSdk = (await authenticateIngestionKey((await listKeys(t.ctx, t.app.id)).sdkKeys.find((k) => k.environment_id === prod.id)!.key))!;
  otherSdk = (await authenticateIngestionKey(other.sdkKey))!;
  for (const p of [sdk, prodSdk, otherSdk]) expect((await ingest(p, { batch: seed() }, { mode: "batch" })).body).toMatchObject({ accepted: 5 });
  await processPendingEvents({ limit: 100 });

  const { jobId } = await requestDeletion({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: "u1" });
  expect(await runDeletionJobs({ jobIds: [jobId] })).toEqual({ completed: 1, failed: 0 });
  expect(await eventsWhere(t.dev.id, "(user_id = 'u1' or anonymous_id = 'a1')")).toBe(0);
});

describe("tombstones written by a deletion", () => {
  it("records the deleted user_id and the install, hashed per environment", async () => {
    const rows = await withTenant({ organizationId: t.org.id, userId: null }, (db) =>
      db.query<{ kind: string; subject_hash: string; privacy_request_id: string | null; deleted_at: Date }>(
        "select kind, subject_hash, privacy_request_id, deleted_at from platform.privacy_tombstones where environment_id = $1 order by kind",
        [t.dev.id],
      ),
    );
    expect(rows.map((r) => [r.kind, r.subject_hash])).toEqual([
      ["anonymous_id", tombstoneHash(t.dev.id, "anonymous_id", "a1")],
      ["user_id", tombstoneHash(t.dev.id, "user_id", "u1")],
    ]);
    expect(rows.every((r) => r.privacy_request_id && r.deleted_at)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/"(u1|a1)"/);
    expect(tombstoneHash(t.dev.id, "user_id", "u1")).not.toBe(tombstoneHash(other.dev.id, "user_id", "u1"));
  });

  it("is idempotent when the deletion is requested again", async () => {
    const { jobId } = await requestDeletion({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: "u1" });
    expect(await runDeletionJobs({ jobIds: [jobId] })).toEqual({ completed: 1, failed: 0 });
    expect(await count("select count(*) as n from platform.privacy_tombstones where environment_id = $1", [t.dev.id])).toBe(2);
  });
});

describe("ingestion after the deletion", () => {
  it("drops the deleted user's queued events by user_id and by the deleted install, and stores the rest", async () => {
    const batch = [
      ev({ anonymous_id: "a1", user_id: "u1" }), // old queued event of u1
      ev({ anonymous_id: "a1" }), // u1's install, anonymous
      ev({ type: "consent", anonymous_id: "a1", user_id: "u1", consent: { analytics: true } }), // would re-create consent rows
      ev({ anonymous_id: "a-new", user_id: "u1" }), // a backend or another device, still u1
      ev({ anonymous_id: "a2", user_id: "u2" }), // someone else
      ev({ type: "identify", anonymous_id: "a1", user_id: "u3" }), // a new person signing in on u1's old phone
    ];
    const r = await ingest(sdk, { batch }, { mode: "batch" });
    expect(r.status).toBe(200);
    const body = r.body as IngestResponse;
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(0);
    expect(body.rejected.map((x) => [x.index, x.reason, x.event_id])).toEqual([0, 1, 2, 3].map((i) => [i, "subject_deleted", batch[i].event_id]));
    expect(body.rejected[0].errors[0].message).toMatch(/deleted by a privacy request/);

    expect(await eventsWhere(t.dev.id, "user_id = 'u1'")).toBe(0);
    expect(await eventsWhere(t.dev.id, "user_id is null and anonymous_id = 'a1'")).toBe(0);
    expect(await count("select count(*) as n from platform.consent_records where environment_id = $1 and user_key in ('u1', 'anon:a1')", [t.dev.id])).toBe(0);
    expect(await count("select count(*) as n from platform.consent_state where environment_id = $1 and user_key in ('u1', 'anon:a1')", [t.dev.id])).toBe(0);
    expect(await eventsWhere(t.dev.id, "user_id = 'u2'")).toBe(3);
    expect(await eventsWhere(t.dev.id, "user_id = 'u3' and anonymous_id = 'a1'")).toBe(1);

    const batchRow = await withSystem((db) => db.one<{ rejected_count: number; accepted_count: number }>("select rejected_count, accepted_count from platform.event_batches where id = $1", [body.batch_id]));
    expect(batchRow).toEqual({ rejected_count: 4, accepted_count: 2 });

    // Processing what was stored doesn't bring u1 back either.
    await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
    expect(await count("select count(*) as n from platform.app_users where environment_id = $1 and external_id = 'u1'", [t.dev.id])).toBe(0);
  });

  it("drops a backend's events and a single event (200, not a client error)", async () => {
    const backend = await ingest(server, { batch: [ev({ user_id: "u1" }), ev({ user_id: "u2" })] }, { mode: "batch" });
    expect((backend.body as IngestResponse).rejected.map((x) => [x.index, x.reason])).toEqual([[0, "subject_deleted"]]);
    expect((backend.body as IngestResponse).accepted).toBe(1);

    const single = await ingest(sdk, ev({ anonymous_id: "a1", user_id: "u1" }), { mode: "single" });
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({ accepted: 0, duplicates: 0, rejected: [{ index: 0, reason: "subject_deleted" }] });
    // An invalid single event is still a 400.
    expect((await ingest(sdk, { type: "track", user_id: "u1" }, { mode: "single" })).status).toBe(400);
    expect(await eventsWhere(t.dev.id, "user_id = 'u1'")).toBe(0);
  });

  it("leaves other environments and organizations alone", async () => {
    for (const p of [prodSdk, otherSdk]) {
      const r = await ingest(p, { batch: [ev({ anonymous_id: "a1", user_id: "u1" }), ev({ anonymous_id: "a1" })] }, { mode: "batch" });
      expect(r.body).toMatchObject({ accepted: 2, rejected: [] });
      expect(await eventsWhere(p.environmentId, "user_id = 'u1'")).toBe(3);
      expect(await eventsWhere(p.environmentId, "user_id is null and anonymous_id = 'a1'")).toBe(2);
    }
  });

  it("an anonymous-only deletion blocks that install's anonymous events only", async () => {
    await ingest(sdk, { batch: [ev({ anonymous_id: "a9" })] }, { mode: "batch" });
    const { jobId } = await requestDeletion({ kind: "user", ctx: t.ctx }, t.dev.id, { anonymousId: "a9" });
    await runDeletionJobs({ jobIds: [jobId] });
    const r = await ingest(sdk, { batch: [ev({ anonymous_id: "a9" }), ev({ anonymous_id: "a9", user_id: "u9" })] }, { mode: "batch" });
    expect((r.body as IngestResponse).rejected.map((x) => [x.index, x.reason])).toEqual([[0, "subject_deleted"]]);
    expect(await eventsWhere(t.dev.id, "anonymous_id = 'a9'")).toBe(1);
  });
});

describe("concurrency", () => {
  it("a deletion waits for in-flight ingestion of its environment before deleting", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const ingestion = withSystem(async (db) => {
      await lockTombstonesShared(db, t.dev.id);
      locked();
      await held;
    });
    await isLocked;
    let waited = false;
    const barrier = waitForIngestion(t.dev.id).then(() => (waited = true));
    // Another environment is not held up.
    await waitForIngestion(other.dev.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(waited).toBe(false);
    release();
    await ingestion;
    await barrier;
    expect(waited).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("another organization can't see, change or add tombstones of this one", async () => {
    const o = { organizationId: other.org.id, userId: other.user.id };
    expect(await withTenant(o, (db) => db.query("select 1 from platform.privacy_tombstones where organization_id <> $1", [other.org.id]))).toHaveLength(0);
    expect(await withTenant(o, (db) => db.query("delete from platform.privacy_tombstones where environment_id = $1 returning 1", [t.dev.id]))).toHaveLength(0);
    await expect(
      withTenant(o, (db) =>
        db.query("insert into platform.privacy_tombstones (organization_id, environment_id, kind, subject_hash) values ($1, $2, 'user_id', $3)", [t.org.id, t.dev.id, tombstoneHash(t.dev.id, "user_id", "u2")]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Its own row can't point at this organization's environment (composite foreign key).
    await expect(
      withTenant(o, (db) =>
        db.query("insert into platform.privacy_tombstones (organization_id, environment_id, kind, subject_hash) values ($1, $2, 'user_id', $3)", [other.org.id, t.dev.id, tombstoneHash(t.dev.id, "user_id", "u2")]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await count("select count(*) as n from platform.privacy_tombstones where environment_id = $1", [t.dev.id])).toBe(3); // u1, a1, a9
  });
});
