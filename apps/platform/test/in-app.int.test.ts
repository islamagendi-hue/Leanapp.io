/**
 * The SDK's in-app endpoints: public-key auth, per-user filtering, actions,
 * expiry, and tenant/environment isolation, through the route handlers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { createApiKey } from "@/modules/credentials/service";
import * as listRoute from "@/app/v1/in-app/route";
import * as actionRoute from "@/app/v1/in-app/[id]/events/route";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
const ids: Record<string, string> = {};

const get = (key: string | null, query: string) =>
  listRoute.GET(new Request(`http://localhost/v1/in-app?${query}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }));
const act = (key: string, id: string, body: unknown) =>
  actionRoute.POST(new Request(`http://localhost/v1/in-app/${id}/events`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

async function message(tenant: T, envId: string, userKey: string, title: string, expires = "1 day") {
  const row = await withSystem((db) =>
    db.one<{ id: string }>(
      `insert into platform.in_app_messages (organization_id, app_id, environment_id, user_key, title, body, expires_at)
       values ($1, $2, $3, $4, $5, 'body', now() + $6::interval) returning id`,
      [tenant.org.id, tenant.app.id, envId, userKey, title, expires],
    ),
  );
  return row!.id;
}

beforeAll(async () => {
  t = await makeTenant("inapp");
  other = await makeTenant("inapp-other");
  const prod = t.environments.find((e) => e.type === "production")!;
  ids.u1 = await message(t, t.dev.id, "u1", "For u1");
  ids.anon = await message(t, t.dev.id, "anon:a1", "For install a1");
  ids.u2 = await message(t, t.dev.id, "u2", "For u2");
  ids.expired = await message(t, t.dev.id, "u1", "Expired", "-1 hour");
  ids.prod = await message(t, prod.id, "u1", "Production only");
  ids.otherU1 = await message(other, other.dev.id, "u1", "Other tenant's u1");
});

describe("GET /v1/in-app", () => {
  it("needs a valid key and a user", async () => {
    expect((await get(null, "user_id=u1")).status).toBe(401);
    expect((await get("la_pk_test_nope", "user_id=u1")).status).toBe(401);
    expect((await get(t.sdkKey, "")).status).toBe(422);
  });

  it("returns the user's (and install's) pending messages in the key's environment only", async () => {
    const res = await get(t.sdkKey, "user_id=u1&anonymous_id=a1");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { messages } = (await res.json()) as { messages: { id: string; title: string }[] };
    expect(messages.map((m) => m.title).sort()).toEqual(["For install a1", "For u1"]);
    // Same user id in another tenant: only their own message.
    const theirs = (await (await get(other.sdkKey, "user_id=u1")).json()) as { messages: { title: string }[] };
    expect(theirs.messages.map((m) => m.title)).toEqual(["Other tenant's u1"]);
  });

  it("accepts a secret key of the environment too", async () => {
    const { key } = await createApiKey(t.ctx, t.dev.id, { label: "server" });
    const { messages } = (await (await get(key, "user_id=u2")).json()) as { messages: { title: string }[] };
    expect(messages.map((m) => m.title)).toEqual(["For u2"]);
  });
});

describe("POST /v1/in-app/{id}/events", () => {
  it("records impression, click and dismissal for the addressed user only", async () => {
    expect((await act(t.sdkKey, ids.u1, { action: "impression", user_id: "u2" })).status).toBe(404);
    expect((await act(other.sdkKey, ids.u1, { action: "impression", user_id: "u1" })).status).toBe(404);
    expect((await act(t.sdkKey, ids.prod, { action: "impression", user_id: "u1" })).status).toBe(404);
    expect((await act(t.sdkKey, ids.u1, { action: "explode", user_id: "u1" })).status).toBe(422);

    const shown = await act(t.sdkKey, ids.u1, { action: "impression", user_id: "u1" });
    expect(await shown.json()).toEqual({ status: "displayed" });
    // Displayed messages are still returned until acted on.
    let { messages } = (await (await get(t.sdkKey, "user_id=u1")).json()) as { messages: { id: string }[] };
    expect(messages.map((m) => m.id)).toContain(ids.u1);

    expect(await (await act(t.sdkKey, ids.u1, { action: "dismiss", user_id: "u1" })).json()).toEqual({ status: "dismissed" });
    // A later impression doesn't resurrect it.
    expect(await (await act(t.sdkKey, ids.u1, { action: "impression", user_id: "u1" })).json()).toEqual({ status: "dismissed" });
    ({ messages } = (await (await get(t.sdkKey, "user_id=u1")).json()) as { messages: { id: string }[] });
    expect(messages).toEqual([]);

    expect(await (await act(t.sdkKey, ids.anon, { action: "click", anonymous_id: "a1" })).json()).toEqual({ status: "clicked" });
    const row = await withSystem((db) => db.one<{ displayed_at: Date | null; clicked_at: Date | null }>("select displayed_at, clicked_at from platform.in_app_messages where id = $1", [ids.anon]));
    expect(row!.displayed_at).not.toBeNull();
    expect(row!.clicked_at).not.toBeNull();
  });
});
