/**
 * Public management API with secret keys, through the route handlers:
 * every endpoint, scope denial, environment and tenant isolation, request
 * logs and the rate limit.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, createApiKey } from "@/modules/credentials/service";
import { addPlanEvent, readPlan } from "@/modules/implementation/editor";
import { approveVersion, publishVersion } from "@/modules/implementation/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import * as appRoute from "@/app/v1/app/route";
import * as envRoute from "@/app/v1/environment/route";
import * as planRoute from "@/app/v1/tracking-plan/route";
import * as planEventsRoute from "@/app/v1/tracking-plan/events/route";
import * as eventsRoute from "@/app/v1/analytics/events/route";
import * as trendRoute from "@/app/v1/analytics/trend/route";
import * as userRoute from "@/app/v1/users/[user_id]/route";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
const ALL = ["management:read", "plan:write", "analytics:read", "users:read"];
const keys: Record<string, string> = {};

const BASE = "https://api.leanapp.test";
const get = (path: string, key?: string) => new Request(`${BASE}${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
const post = (path: string, key: string, body: unknown) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const userGet = (id: string, key?: string) => userRoute.GET(get(`/v1/users/${encodeURIComponent(id)}`, key), { params: Promise.resolve({ user_id: id }) });

const ev = (o: Record<string, unknown>) => ({ type: "track", event_id: crypto.randomUUID(), anonymous_id: "anon-1", ...o });

beforeAll(async () => {
  t = await makeTenant("mgmt");
  other = await makeTenant("mgmt-other");
  const prod = t.environments.find((e) => e.type === "production")!;
  keys.all = (await createApiKey(t.ctx, t.dev.id, { label: "all", scopes: ALL })).key;
  keys.eventsOnly = (await createApiKey(t.ctx, t.dev.id, { label: "events" })).key;
  keys.read = (await createApiKey(t.ctx, t.dev.id, { scopes: ["management:read"] })).key;
  keys.prod = (await createApiKey(t.ctx, prod.id, { scopes: ALL })).key;
  keys.other = (await createApiKey(other.ctx, other.dev.id, { scopes: ALL })).key;

  // Development: two users and their events. Production: different events.
  const dev = (await authenticateIngestionKey(t.sdkKey))!;
  await ingest(dev, { batch: [
    ev({ type: "identify", user_id: "u1", user_properties: { city: "Riyadh" } }),
    ev({ event_name: "order_completed", user_id: "u1" }),
    ev({ event_name: "order_completed", user_id: "u1" }),
    ev({ event_name: "search_performed", user_id: "u1" }),
    ev({ event_name: "search_performed", anonymous_id: "anon-2" }),
    ev({ event_name: "search_performed", anonymous_id: "anon-3" }),
  ] }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
  const prodKey = (await authenticateIngestionKey(keys.prod))!;
  await ingest(prodKey, { batch: [ev({ event_name: "prod_only_event", user_id: "p1" }), ev({ type: "identify", user_id: "p1" })] }, { mode: "batch" });
  await processPendingEvents({ environmentId: prod.id, limit: 100 });
});

describe("authentication and scopes", () => {
  it("401 without a valid key, 403 for public SDK keys and missing scopes", async () => {
    expect((await appRoute.GET(get("/v1/app"))).status).toBe(401);
    expect((await appRoute.GET(get("/v1/app", "la_sk_dev_" + "x".repeat(43)))).status).toBe(401);
    expect((await appRoute.GET(get("/v1/app", t.sdkKey))).status).toBe(403);
    const cases: [string, Promise<Response>][] = [
      ["app", appRoute.GET(get("/v1/app", keys.eventsOnly))],
      ["environment", envRoute.GET(get("/v1/environment", keys.eventsOnly))],
      ["plan", planRoute.GET(get("/v1/tracking-plan", keys.eventsOnly))],
      ["plan write", planEventsRoute.POST(post("/v1/tracking-plan/events", keys.read, { event_name: "thing_happened" }))],
      ["events", eventsRoute.GET(get("/v1/analytics/events", keys.read))],
      ["trend", trendRoute.GET(get("/v1/analytics/trend?event=order_completed", keys.read))],
      ["user", userGet("u1", keys.read)],
    ];
    for (const [name, p] of cases) {
      const res = await p;
      expect(res.status, name).toBe(403);
      expect((await res.json()).error, name).toBe("forbidden");
    }
  });

  it("rejects unknown scopes at key creation", async () => {
    await expect(createApiKey(t.ctx, t.dev.id, { scopes: ["admin:all"] })).rejects.toThrow(/Unknown scope/);
  });
});

describe("apps and environments", () => {
  it("returns the key's app with only the key's environment", async () => {
    const res = await appRoute.GET(get("/v1/app", keys.read));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ id: t.app.id, slug: t.app.slug, platforms: ["android", "ios"], environment: { id: t.dev.id, type: "development" } });
    expect(JSON.stringify(body)).not.toContain(t.environments.find((e) => e.type === "production")!.id);
    const env = await (await envRoute.GET(get("/v1/environment", keys.prod))).json();
    expect(env.type).toBe("production");
  });
});

describe("tracking plan", () => {
  it("404 before anything is published, then the published version as JSON", async () => {
    const none = await planRoute.GET(get("/v1/tracking-plan", keys.read));
    expect(none.status).toBe(404);

    const created = await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.all, {
      event_name: "order_completed", required: true, source: "backend",
      properties: [{ name: "revenue", type: "number", required: true }, { name: "currency", type: "currency", required: true }],
    }));
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c).toMatchObject({ version: 1, status: "draft", draft_created: true, event_name: "order_completed", warnings: [] });

    // Still nothing published: the API can't publish, a person approves.
    expect((await planRoute.GET(get("/v1/tracking-plan", keys.read))).status).toBe(404);
    await approveVersion(t.ctx, t.app.id, c.version_id);
    await publishVersion(t.ctx, t.app.id, c.version_id);

    const res = await planRoute.GET(get("/v1/tracking-plan", keys.prod));
    expect(res.status).toBe(200);
    const plan = await res.json();
    expect(plan).toMatchObject({ format: "leanapp.tracking_plan/v1", version: 1, status: "published", app: { id: t.app.id } });
    expect(plan.events.map((e: { event_name: string }) => e.event_name)).toEqual(["order_completed"]);
    expect(plan.events[0].properties).toHaveLength(2);
  });

  it("adds custom events to a new draft without touching the published version", async () => {
    const res = await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.all, { event_name: "coupon_applied", properties: [{ name: "coupon_code", type: "string" }] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ version: 2, draft_created: true });
    const published = await readPlan({ kind: "user", ctx: t.ctx }, t.app.id, "published");
    expect(published!.version.version).toBe(1);
    expect(published!.events.map((e) => e.event_name)).toEqual(["order_completed"]);
    const second = await (await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.all, { event_name: "coupon_removed" }))).json();
    expect(second).toMatchObject({ version: 2, draft_created: false });

    const audit = await withSystem((db) => db.query<{ actor_type: string; actor_user_id: string | null; metadata: { api_key_id?: string } }>(
      "select actor_type, actor_user_id, metadata from platform.audit_logs where organization_id = $1 and action like 'tracking_plan.%' and actor_type = 'api_key'",
      [t.org.id],
    ));
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(audit.every((a) => a.actor_user_id === null && a.metadata.api_key_id)).toBe(true);
  });

  it("rejects invalid and duplicate events", async () => {
    const bad = await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.all, { event_name: "Coupon Applied" }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe("validation_error");
    const dup = await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.all, { event_name: "coupon_applied" }));
    expect(dup.status).toBe(409);
    const notJson = await planEventsRoute.POST(new Request(`${BASE}/v1/tracking-plan/events`, { method: "POST", headers: { authorization: `Bearer ${keys.all}` }, body: "{" }));
    expect(notJson.status).toBe(422);
  });

  it("another tenant's key sees its own (empty) plan only", async () => {
    expect((await planRoute.GET(get("/v1/tracking-plan", keys.other))).status).toBe(404);
    const r = await (await planEventsRoute.POST(post("/v1/tracking-plan/events", keys.other, { event_name: "coupon_applied" }))).json();
    expect(r.version).toBe(1);
    const mine = await readPlan({ kind: "user", ctx: t.ctx }, t.app.id, "published");
    expect(mine!.version.version).toBe(1);
    // Direct service call with a forged app id is refused too.
    const otherKey = (await authenticateIngestionKey(keys.other))!;
    await expect(addPlanEvent({ kind: "api_key", organizationId: otherKey.organizationId, appId: otherKey.appId, keyId: otherKey.keyId }, t.app.id, { event_name: "x_done" })).rejects.toThrow(/not found/);
  });
});

describe("analytics", () => {
  it("top events of the key's environment only", async () => {
    const res = await eventsRoute.GET(get("/v1/analytics/events?days=7", keys.all));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ environment_id: t.dev.id, days: 7 });
    expect(body.events).toEqual([{ name: "search_performed", count: 3, people: 3 }, { name: "order_completed", count: 2, people: 1 }]);

    const prod = await (await eventsRoute.GET(get("/v1/analytics/events", keys.prod))).json();
    expect(prod.days).toBe(30);
    expect(prod.events.map((e: { name: string }) => e.name)).toEqual(["prod_only_event"]);
    const foreign = await (await eventsRoute.GET(get("/v1/analytics/events", keys.other))).json();
    expect(foreign.events).toEqual([]);
  });

  it("daily trend for one event", async () => {
    const res = await trendRoute.GET(get("/v1/analytics/trend?event=order_completed&days=7", keys.all));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ event: "order_completed", environment_id: t.dev.id, timezone: expect.any(String), total: { count: 2, people: 1 } });
    expect(body.days).toHaveLength(body.series[0].counts.length);
    const prod = await (await trendRoute.GET(get("/v1/analytics/trend?event=order_completed", keys.prod))).json();
    expect(prod.total.count).toBe(0);
    expect((await trendRoute.GET(get("/v1/analytics/trend", keys.all))).status).toBe(422);
  });
});

describe("users", () => {
  it("looks up a user of the key's environment", async () => {
    const res = await userGet("u1", keys.all);
    expect(res.status).toBe(200);
    const u = await res.json();
    expect(u).toMatchObject({ user_id: "u1", properties: { city: "Riyadh" }, anonymous_ids: ["anon-1"], event_count: 3 }); // 3 track events; the identify call is not an event in reports
  });

  it("is not found from another environment or tenant", async () => {
    expect((await userGet("u1", keys.prod)).status).toBe(404);
    expect((await userGet("p1", keys.all)).status).toBe(404);
    expect((await userGet("p1", keys.prod)).status).toBe(200);
    expect((await userGet("u1", keys.other)).status).toBe(404);
  });
});

describe("request logs and rate limit", () => {
  it("logs authenticated requests, refusals included, without ids in the route", async () => {
    const rows = await withSystem((db) => db.query<{ route: string; status_code: number; error_code: string | null; credential_kind: string }>(
      "select route, status_code, error_code, credential_kind from platform.api_request_logs where environment_id = $1", [t.dev.id],
    ));
    expect(rows.some((r) => r.route === "GET /v1/app" && r.status_code === 200)).toBe(true);
    expect(rows.some((r) => r.route === "GET /v1/users/{user_id}" && r.status_code === 403 && r.error_code === "forbidden")).toBe(true);
    expect(rows.some((r) => r.route === "POST /v1/tracking-plan/events" && r.status_code === 201)).toBe(true);
    expect(rows.some((r) => r.route === "POST /v1/tracking-plan/events" && r.status_code === 409 && r.error_code === "conflict")).toBe(true);
    expect(rows.some((r) => r.credential_kind === "sdk" && r.status_code === 403)).toBe(true);
    expect(rows.every((r) => !r.route.includes("u1"))).toBe(true);
    const foreign = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.api_request_logs where environment_id = $1", [other.dev.id]));
    expect(Number(foreign!.n)).toBeGreaterThan(0);
  });

  it("returns 429 with Retry-After once the environment's minute budget is spent", async () => {
    const now = Date.now();
    await withSystem(async (db) => {
      for (const w of [0, 60_000]) {
        await db.query(
          "insert into platform.rate_limit_buckets (key, window_start, count) values ($1, $2, 1000000) on conflict (key, window_start) do update set count = 1000000",
          [`mgmt:${t.dev.id}`, new Date(Math.floor((now + w) / 60_000) * 60_000)],
        );
      }
    });
    const res = await appRoute.GET(get("/v1/app", keys.read));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // Other environments keep their own budget.
    expect((await appRoute.GET(get("/v1/app", keys.prod))).status).toBe(200);
  });
});
