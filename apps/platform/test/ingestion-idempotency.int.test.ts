/**
 * Idempotency-Key against Postgres: a key replays its stored response only for
 * the same events. The same key with different events (an SDK whose queue
 * changed between a lost response and the retry) is refused with 409, never
 * answered with a response for events that were not stored.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest, type IngestResponse } from "@/modules/ingestion/service";
import { makeTenant } from "./helpers";

let sdk: IngestionPrincipal;

const ev = (eventId: string, extra: Record<string, unknown> = {}) => ({ type: "track", event_name: "item_viewed", event_id: eventId, anonymous_id: "d1", ...extra });
const stored = (ids: string[]) =>
  withSystem((db) =>
    db.query<{ event_id: string }>("select event_id from platform.events where environment_id = $1 and event_id = any($2::text[])", [sdk.environmentId, ids]),
  ).then((rows) => rows.map((r) => r.event_id).sort());

beforeAll(async () => {
  const t = await makeTenant("idem");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;
});

describe("Idempotency-Key bound to the request's events", () => {
  it("replays an identical retry, even with a new sent_at and key order", async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    const key = `${a}:2`;
    const first = await ingest(sdk, { batch: [ev(a), ev(b)], sent_at: new Date().toISOString() }, { mode: "batch", idempotencyKey: key });
    expect(first.status).toBe(200);
    expect((first.body as IngestResponse).accepted).toBe(2);

    const retry = await ingest(
      sdk,
      { sent_at: new Date(Date.now() + 5000).toISOString(), batch: [{ event_id: a, anonymous_id: "d1", event_name: "item_viewed", type: "track" }, ev(b)] },
      { mode: "batch", idempotencyKey: key },
    );
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe(true);
    expect(retry.body).toEqual(first.body);
  });

  it("refuses the same key with different events instead of replaying ([A,B] then [A,C])", async () => {
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const key = `${a}:2`;
    expect((await ingest(sdk, { batch: [ev(a), ev(b)] }, { mode: "batch", idempotencyKey: key })).status).toBe(200);

    const reused = await ingest(sdk, { batch: [ev(a), ev(c)] }, { mode: "batch", idempotencyKey: key });
    expect(reused.status).toBe(409);
    expect(reused.replayed).toBeFalsy();
    expect(reused.body).toMatchObject({ error: "idempotency_key_reused" });
    expect(await stored([a, b, c])).toEqual([a, b].sort()); // C not stored, and not reported as accepted

    // Resending without the key (what the SDKs do on 409) stores C; A is a duplicate by event_id.
    const fresh = await ingest(sdk, { batch: [ev(a), ev(c)] }, { mode: "batch" });
    expect(fresh.body).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(await stored([a, b, c])).toEqual([a, b, c].sort());
  });

  it("order is part of the identity: the stored response refers to events by index", async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    const key = `order-${a}`;
    await ingest(sdk, { batch: [ev(a), ev(b)] }, { mode: "batch", idempotencyKey: key });
    expect((await ingest(sdk, { batch: [ev(b), ev(a)] }, { mode: "batch", idempotencyKey: key })).status).toBe(409);
  });

  it("single events without an event_id are compared by content", async () => {
    const key = `single-${crypto.randomUUID()}`;
    const first = await ingest(sdk, { event_name: "item_viewed", anonymous_id: "d1", properties: { n: 1 } }, { mode: "single", idempotencyKey: key });
    expect(first.status).toBe(200);
    const same = await ingest(sdk, { properties: { n: 1 }, anonymous_id: "d1", event_name: "item_viewed" }, { mode: "single", idempotencyKey: key });
    expect(same.replayed).toBe(true);
    const other = await ingest(sdk, { event_name: "item_viewed", anonymous_id: "d1", properties: { n: 2 } }, { mode: "single", idempotencyKey: key });
    expect(other.status).toBe(409);
  });

  it("rows stored before payload hashes keep replaying", async () => {
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const key = `legacy-${a}`;
    const first = await ingest(sdk, { batch: [ev(a), ev(b)] }, { mode: "batch", idempotencyKey: key });
    await withSystem((db) => db.query("update platform.event_batches set payload_hash = null where environment_id = $1 and idempotency_key = $2", [sdk.environmentId, key]));
    const replay = await ingest(sdk, { batch: [ev(a), ev(c)] }, { mode: "batch", idempotencyKey: key });
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
  });
});
