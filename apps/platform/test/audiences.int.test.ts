/**
 * Audiences against Postgres: compiled conditions over real events and
 * profiles, identity stitching (shared devices), injection attempts,
 * membership transitions, permissions and tenant isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { activateAudience, archiveAudience, createAudience, getAudience, listAudiences, previewAudience, recomputeDueAudiences, updateAudience } from "@/modules/audiences/service";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { resolveTenant } from "@/modules/tenancy/context";
import { signUp } from "@/modules/auth/service";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ev = (o: Record<string, unknown>) => ({ type: "track", event_id: crypto.randomUUID(), timestamp: ago(1), ...o });

async function send(batch: unknown[], principal = sdk, env = t.dev.id) {
  const r = await ingest(principal, { batch }, { mode: "batch" });
  expect((r.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: env, limit: 1000 });
}

const preview = (definition: unknown) => previewAudience(t.ctx, t.dev.id, definition).then((r) => r.sample.sort());

beforeAll(async () => {
  t = await makeTenant("aud");
  other = await makeTenant("aud-other");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;
  await send([
    // u1: iOS, gold plan, two purchases (revenue 80 + 40), anonymous install a1 stitched to u1.
    ev({ event_name: "app_opened", anonymous_id: "a1", context: { platform: "ios" }, timestamp: ago(29) }),
    { type: "identify", event_id: crypto.randomUUID(), timestamp: ago(29), anonymous_id: "a1", user_id: "u1", user_properties: { plan: "gold", age: 31, email: "u1@example.com" }, context: { platform: "ios" } },
    ev({ event_name: "purchase", anonymous_id: "a1", user_id: "u1", properties: { revenue: 80, sku: "A" }, context: { platform: "ios" } }),
    ev({ event_name: "purchase", anonymous_id: "a1", user_id: "u1", properties: { revenue: "40", sku: "B" }, context: { platform: "ios" }, timestamp: ago(2) }),
    // Anonymous activity on a1 before sign-up belongs to u1.
    ev({ event_name: "checkout_started", anonymous_id: "a1", context: { platform: "ios" }, timestamp: ago(3) }),
    // u2: android, silver, started checkout, no purchase.
    { type: "identify", event_id: crypto.randomUUID(), timestamp: ago(5), anonymous_id: "a2", user_id: "u2", user_properties: { plan: "silver", age: 19 }, context: { platform: "android" } },
    ev({ event_name: "checkout_started", anonymous_id: "a2", user_id: "u2", context: { platform: "android" } }),
    // Shared tablet a4 linked to u3 and u4: its anonymous events are the anonymous person anon:a4.
    { type: "identify", event_id: crypto.randomUUID(), timestamp: ago(2), anonymous_id: "a4", user_id: "u3", context: { platform: "android" } },
    { type: "identify", event_id: crypto.randomUUID(), timestamp: ago(2), anonymous_id: "a4", user_id: "u4", context: { platform: "android" } },
    ev({ event_name: "checkout_started", anonymous_id: "a4", context: { platform: "android" } }),
    // a5: never signed in.
    ev({ event_name: "app_opened", anonymous_id: "a5", context: { platform: "web" } }),
  ]);
  // The other tenant has a u1 too: never visible here.
  await send([ev({ event_name: "purchase", anonymous_id: "a1", user_id: "u1", properties: { revenue: 999 } })], (await authenticateIngestionKey(other.sdkKey))!, other.dev.id);
});

describe("conditions", () => {
  it("event counts within windows, with stitching and the shared-device rule", async () => {
    expect(await preview({ type: "event", event: "purchase" })).toEqual(["u1"]);
    expect(await preview({ type: "event", event: "purchase", count: 2 })).toEqual(["u1"]);
    expect(await preview({ type: "event", event: "purchase", count: 3 })).toEqual([]);
    expect(await preview({ type: "event", event: "purchase", withinDays: 1, count: 1 })).toEqual([]);
    expect(await preview({ type: "event", event: "checkout_started" })).toEqual(["anon:a4", "u1", "u2"]);
    // Everyone else did not purchase (people with no events at all included).
    expect(await preview({ type: "event", event: "purchase", did: false })).toEqual(["anon:a4", "anon:a5", "u2", "u3", "u4"]);
  });

  it("event property filters", async () => {
    expect(await preview({ type: "event", event: "purchase", where: [{ property: "sku", op: "eq", value: "B" }] })).toEqual(["u1"]);
    expect(await preview({ type: "event", event: "purchase", where: [{ property: "revenue", op: "gt", value: 50 }], count: 2 })).toEqual([]);
    expect(await preview({ type: "event", event: "purchase", where: [{ property: "sku", op: "in", value: ["X", "Y"] }] })).toEqual([]);
  });

  it("user properties, first seen, platform and revenue", async () => {
    expect(await preview({ type: "user_property", property: "plan", op: "eq", value: "gold" })).toEqual(["u1"]);
    expect(await preview({ type: "user_property", property: "age", op: "gte", value: 20 })).toEqual(["u1"]);
    expect(await preview({ type: "user_property", property: "email", op: "exists" })).toEqual(["u1"]);
    expect(await preview({ type: "user_property", property: "plan", op: "contains", value: "IL" })).toEqual(["u2"]);
    expect(await preview({ type: "first_seen", op: "before_days", days: 20 })).toEqual(["u1"]);
    expect(await preview({ type: "platform", platforms: ["ios", "web"] })).toEqual(["anon:a5", "u1"]);
    expect(await preview({ type: "revenue", op: "gte", amount: 120 })).toEqual(["u1"]);
    expect(await preview({ type: "revenue", op: "gt", amount: 120 })).toEqual([]);
    expect((await preview({ type: "revenue", op: "lt", amount: 1 })).length).toBe(5); // zero revenue counts
  });

  it("boolean structure", async () => {
    expect(await preview({ type: "and", children: [{ type: "event", event: "checkout_started" }, { type: "event", event: "purchase", did: false }] })).toEqual(["anon:a4", "u2"]);
    expect(await preview({ type: "or", children: [{ type: "user_property", property: "plan", op: "eq", value: "gold" }, { type: "platform", platforms: ["web"] }] })).toEqual(["anon:a5", "u1"]);
    // u3 and u4 have no install of their own (only the shared tablet), so no platform.
    expect(await preview({ type: "not", child: { type: "platform", platforms: ["android"] } })).toEqual(["anon:a5", "u1", "u3", "u4"]);
  });

  it("treats injection attempts as data", async () => {
    const evil = "purchase' or '1'='1";
    expect(await preview({ type: "event", event: evil })).toEqual([]);
    expect(await preview({ type: "user_property", property: "plan", op: "eq", value: "x' or 1=1 --" })).toEqual([]);
    expect(await preview({ type: "user_property", property: "plan", op: "contains", value: "%" })).toEqual([]);
    await expect(preview({ type: "user_property", property: "plan'); drop table platform.events; --", op: "eq", value: "x" })).rejects.toThrow(/Property names/);
    const n = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.events where environment_id = $1", [t.dev.id]));
    expect(Number(n!.n)).toBeGreaterThan(0);
  });

  it("excludes people with a pending deletion request", async () => {
    await withSystem((db) =>
      db.query("insert into platform.privacy_requests (organization_id, environment_id, kind, subject_user_id) values ($1, $2, 'deletion', 'u2')", [t.org.id, t.dev.id]),
    );
    expect(await preview({ type: "event", event: "checkout_started" })).toEqual(["anon:a4", "u1"]);
    await withSystem((db) => db.query("update platform.privacy_requests set status = 'rejected' where subject_user_id = 'u2' and environment_id = $1", [t.dev.id]));
  });
});

describe("membership", () => {
  let id: string;

  it("activates with a baseline, then records entered/exited transitions", async () => {
    ({ id } = await createAudience(t.ctx, t.dev.id, { name: "Gold plan", definition: { type: "user_property", property: "plan", op: "eq", value: "gold" } }));
    expect((await activateAudience(t.ctx, id)).size).toBe(1);
    let d = await getAudience(t.ctx, id);
    expect(d.members.map((m) => m.user_key)).toEqual(["u1"]);
    expect(d.recent).toEqual([]); // baseline entries are initial
    expect(d.history).toHaveLength(1);

    // u2 upgrades, u1 downgrades.
    await send([
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "a2", user_id: "u2", user_properties: { plan: "gold" } },
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "a1", user_id: "u1", user_properties: { plan: "silver" } },
    ]);
    // Not due yet (refresh every 15 min) …
    expect((await recomputeDueAudiences()).computed).toBe(0);
    await withSystem((db) => db.query("update platform.audiences set last_computed_at = now() - interval '1 hour' where id = $1", [id]));
    expect(await recomputeDueAudiences()).toEqual({ computed: 1, failed: 0 });
    d = await getAudience(t.ctx, id);
    expect(d.audience.member_count).toBe(1);
    expect(d.members.map((m) => m.user_key)).toEqual(["u2"]);
    expect(d.recent.map((r) => `${r.kind}:${r.user_key}`).sort()).toEqual(["entered:u2", "exited:u1"]);
    expect(d.history.at(-1)).toMatchObject({ member_count: 1, entered: 1, exited: 1 });

    // u1 comes back: re-entry clears exited_at and records a new transition.
    await send([{ type: "identify", event_id: crypto.randomUUID(), anonymous_id: "a1", user_id: "u1", user_properties: { plan: "gold" } }]);
    await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [id]));
    await recomputeDueAudiences();
    const rows = await withSystem((db) => db.query<{ user_key: string; exited_at: Date | null }>("select user_key, exited_at from platform.audience_members where audience_id = $1 order by user_key", [id]));
    expect(rows.map((r) => [r.user_key, r.exited_at === null])).toEqual([["u1", true], ["u2", true]]);
  });

  it("an edited definition re-baselines instead of firing transitions", async () => {
    await updateAudience(t.ctx, id, { name: "Checkout starters", definition: { type: "event", event: "checkout_started" } });
    await recomputeDueAudiences();
    const events = await withSystem((db) => db.query<{ user_key: string; kind: string; initial: boolean }>("select user_key, kind, initial from platform.audience_events where audience_id = $1 order by id desc limit 1", [id]));
    expect(events[0]).toEqual({ user_key: "anon:a4", kind: "entered", initial: true });
  });

  it("is concurrency safe: two workers never compute the same audience at once", async () => {
    const count = async () => (await withSystem((db) => db.query("select 1 from platform.audience_snapshots where audience_id = $1", [id]))).length;
    const before = await count();
    await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [id]));
    const [a, b] = await Promise.all([recomputeDueAudiences(), recomputeDueAudiences()]);
    // The second worker either skipped the locked row or found it no longer due.
    expect(a.computed + b.computed).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  it("archives", async () => {
    await archiveAudience(t.ctx, id);
    expect((await listAudiences(t.ctx, t.dev.id)).find((a) => a.id === id)).toBeUndefined();
  });
});

describe("permissions and isolation", () => {
  it("other tenants can't see or use the audience or the environment", async () => {
    const { id } = await createAudience(t.ctx, t.dev.id, { name: "Purchasers", definition: { type: "event", event: "purchase" } });
    await expect(getAudience(other.ctx, id)).rejects.toThrow(/not found/);
    await expect(createAudience(other.ctx, t.dev.id, { name: "Steal", definition: { type: "event", event: "purchase" } })).rejects.toThrow(/not found/);
    // Previewing someone else's environment under your own scope sees nothing.
    expect((await previewAudience(other.ctx, t.dev.id, { type: "event", event: "purchase" })).size).toBe(0);
    expect((await previewAudience(other.ctx, other.dev.id, { type: "event", event: "purchase" })).sample).toEqual(["u1"]);
  });

  it("analysts read, marketers manage, developers neither", async () => {
    const roles = ["analyst", "marketer", "developer"] as const;
    const ctxs = await Promise.all(
      roles.map(async (role, i) => {
        const { user } = await signUp({ name: role, email: `${role}-${Date.now()}-${i}@example.com`, password: "correct-horse-9" }, { ip: `10.9.${i}.1` });
        await withSystem((db) => db.query("insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, $3)", [t.org.id, user.id, role]));
        return resolveTenant(user.id, t.org.slug);
      }),
    );
    const [analyst, marketer, developer] = ctxs;
    await expect(listAudiences(analyst, t.dev.id)).resolves.toBeDefined();
    await expect(createAudience(analyst, t.dev.id, { name: "No", definition: { type: "event", event: "x" } })).rejects.toThrow(/permission/);
    await expect(createAudience(marketer, t.dev.id, { name: "Yes", definition: { type: "event", event: "x" } })).resolves.toHaveProperty("id");
    await expect(listAudiences(developer, t.dev.id)).rejects.toThrow(/permission/);
  });
});
