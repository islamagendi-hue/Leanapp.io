/**
 * End-user data export and deletion against Postgres: which rows belong to a
 * subject (including shared devices), job execution, tenant and environment
 * scoping, and permissions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, createApiKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { exportSubjectData, getDeletion, listPrivacyRequests, requestDeletion, runDeletionJobs, type Requester } from "@/modules/privacy/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { signIn } from "@/modules/auth/service";
import { apiSecretKey } from "@/server/api";
import { SESSION_COOKIE } from "@/server/session";
import * as exportRoute from "@/app/o/[org]/apps/[app]/privacy/export/route";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let server: IngestionPrincipal;
let apiReq: Requester;

const ev = (o: Record<string, unknown>) => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), session_id: `s-${o.anonymous_id}`, ...o });

async function count(sql: string, values: unknown[]) {
  const row = await withSystem((db) => db.one<{ n: string }>(sql, values));
  return Number(row!.n);
}
const eventsFor = (env: string, where: string, values: unknown[] = []) =>
  count(`select count(*) as n from platform.events where environment_id = $1 and ${where}`, [env, ...values]);

beforeAll(async () => {
  t = await makeTenant("privacy");
  other = await makeTenant("privacy-other");
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  // a1: u1's own phone. a2: a tablet shared by u1 and u2. a3: someone who never signed in.
  const batch = [
    ev({ anonymous_id: "a1" }),
    ev({ anonymous_id: "a1" }),
    ev({ type: "identify", anonymous_id: "a1", user_id: "u1", user_properties: { city: "Riyadh" } }),
    ev({ anonymous_id: "a1", user_id: "u1" }),
    ev({ anonymous_id: "a2" }),
    ev({ type: "identify", anonymous_id: "a2", user_id: "u1" }),
    ev({ type: "identify", anonymous_id: "a2", user_id: "u2", user_properties: { city: "Dubai" } }),
    ev({ anonymous_id: "a2", user_id: "u2" }),
    ev({ anonymous_id: "a3" }),
    ev({ anonymous_id: "a3" }),
  ];
  expect((await ingest(sdk, { batch }, { mode: "batch" })).status).toBe(200);
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
  const secret = await createApiKey(t.ctx, t.dev.id, { label: "privacy" });
  server = (await authenticateIngestionKey(secret.key))!;
  apiReq = { kind: "api_key", organizationId: server.organizationId, environmentId: server.environmentId, keyId: server.keyId };

  // The other tenant has a user with the same id; nothing of theirs may be touched.
  const otherSdk = (await authenticateIngestionKey(other.sdkKey))!;
  await ingest(otherSdk, { batch: [ev({ type: "identify", anonymous_id: "a1", user_id: "u1" }), ev({ anonymous_id: "a1", user_id: "u1" })] }, { mode: "batch" });
  await processPendingEvents({ environmentId: other.dev.id, limit: 100 });
});

describe("export", () => {
  it("returns the subject's rows: their events and their own device's anonymous activity", async () => {
    const x = await exportSubjectData({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: "u1" });
    expect(x.subject.matched_anonymous_ids).toEqual(["a1"]); // a2 is shared with u2
    const events = x.data.events as { user_id: string | null; anonymous_id: string }[];
    // 2 anonymous on a1, identify + event on a1, identify on a2.
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.user_id === "u1" || (e.user_id === null && e.anonymous_id === "a1"))).toBe(true);
    expect(x.data.profiles).toHaveLength(1);
    expect(x.data.installs.map((i) => i.anonymous_id)).toEqual(["a1"]);
    expect(x.data.identity_links).toHaveLength(2);
    expect(JSON.stringify(x)).not.toContain(t.org.id); // organization ids are stripped
    expect(x.truncated).toEqual([]);

    const history = await listPrivacyRequests(t.ctx, t.dev.id);
    expect(history[0]).toMatchObject({ kind: "export", status: "completed", subject_user_id: "u1" });
  });

  it("leaves out a given anonymous_id that another user is linked to, and reports it", async () => {
    // a2 is u2's tablet too: naming it alongside u1 must not hand over u2's anonymous activity.
    const x = await exportSubjectData(apiReq, t.dev.id, { userId: "u1", anonymousId: "a2" });
    expect(x.subject.matched_anonymous_ids).toEqual(["a1"]);
    expect(x.subject.skipped_anonymous_ids).toEqual(["a2"]);
    const events = x.data.events as { user_id: string | null; anonymous_id: string }[];
    expect(events.some((e) => e.user_id === null && e.anonymous_id === "a2")).toBe(false);
    expect(x.data.installs.map((i) => i.anonymous_id)).toEqual(["a1"]);

    // An install nobody else is linked to is included; an anonymous-only request is taken as asked.
    const own = await exportSubjectData(apiReq, t.dev.id, { userId: "u1", anonymousId: "a3" });
    expect(own.subject.matched_anonymous_ids).toEqual(["a1", "a3"]);
    const install = await exportSubjectData(apiReq, t.dev.id, { anonymousId: "a2" });
    expect(install.subject.matched_anonymous_ids).toEqual(["a2"]);
    expect(install.subject.skipped_anonymous_ids).toEqual([]);
  });

  it("validates the subject and scopes keys to their environment", async () => {
    await expect(exportSubjectData(apiReq, t.dev.id, {})).rejects.toThrow(/user_id, an anonymous_id/);
    const prod = t.environments.find((e) => e.type === "production")!;
    await expect(exportSubjectData(apiReq, prod.id, { userId: "u1" })).rejects.toThrow(/not found/i);
    // Another organization's environment id is invisible under RLS.
    await expect(exportSubjectData({ kind: "user", ctx: t.ctx }, other.dev.id, { userId: "u1" })).rejects.toThrow(/not found/i);
  });

  it("needs privacy.manage", async () => {
    await expect(exportSubjectData({ kind: "user", ctx: { ...t.ctx, role: "developer" } }, t.dev.id, { userId: "u1" })).rejects.toThrow(/permission/);
    await expect(requestDeletion({ kind: "user", ctx: { ...t.ctx, role: "analyst" } }, t.dev.id, { userId: "u1" })).rejects.toThrow(/permission/);
  });
});

describe("deletion", () => {
  it("deletes the subject and nothing else", async () => {
    const before = { u2: await eventsFor(t.dev.id, "user_id = 'u2'"), a2anon: await eventsFor(t.dev.id, "anonymous_id = 'a2' and user_id is null"), a3: await eventsFor(t.dev.id, "anonymous_id = 'a3'") };
    const otherBefore = await eventsFor(other.dev.id, "true");

    // a2 is shared with u2, so naming it doesn't delete its anonymous activity.
    const { id, jobId } = await requestDeletion(apiReq, t.dev.id, { userId: "u1", anonymousId: "a2" });
    expect((await getDeletion(apiReq, t.dev.id, id)).status).toBe("received");
    expect(await runDeletionJobs({ jobIds: [jobId] })).toEqual({ completed: 1, failed: 0 });

    const done = await getDeletion(apiReq, t.dev.id, id);
    expect(done.status).toBe("completed");
    expect(done.job).toMatchObject({ status: "completed", attempts: 1 });
    expect(done.job!.details.events).toBe(5);
    expect(done.job!.skipped_anonymous_ids).toEqual(["a2"]);
    expect(done.job!.details.profiles).toBe(1);
    expect(done.job!.rows_deleted).toBeGreaterThanOrEqual(5 + 1 + 1 + 2);

    expect(await eventsFor(t.dev.id, "user_id = 'u1'")).toBe(0);
    expect(await eventsFor(t.dev.id, "anonymous_id = 'a1'")).toBe(0);
    expect(await eventsFor(t.dev.id, "user_id = 'u2'")).toBe(before.u2);
    expect(await eventsFor(t.dev.id, "anonymous_id = 'a2' and user_id is null")).toBe(before.a2anon);
    expect(await eventsFor(t.dev.id, "anonymous_id = 'a3'")).toBe(before.a3);
    expect(await count("select count(*) as n from platform.app_users where environment_id = $1", [t.dev.id])).toBe(1); // u2
    expect(await count("select count(*) as n from platform.identity_links where environment_id = $1 and user_id = 'u1'", [t.dev.id])).toBe(0);
    expect(await count("select count(*) as n from platform.anonymous_users where environment_id = $1 and anonymous_id = 'a2'", [t.dev.id])).toBe(1);
    expect(await eventsFor(other.dev.id, "true")).toBe(otherBefore);

    const audit = await withSystem((db) => db.query<{ action: string; actor_type: string }>("select action, actor_type from platform.audit_logs where organization_id = $1 and action like 'privacy.%'", [t.org.id]));
    expect(audit).toEqual(expect.arrayContaining([{ action: "privacy.deletion_requested", actor_type: "api_key" }, { action: "privacy.deletion_completed", actor_type: "system" }]));
  });

  it("deletes one install's anonymous activity by anonymous_id", async () => {
    const { jobId } = await requestDeletion({ kind: "user", ctx: t.ctx }, t.dev.id, { anonymousId: "a3" });
    await runDeletionJobs({ jobIds: [jobId] });
    expect(await eventsFor(t.dev.id, "anonymous_id = 'a3'")).toBe(0);
    expect(await eventsFor(t.dev.id, "user_id = 'u2'")).toBeGreaterThan(0);
  });

  it("is invisible to other tenants and environments", async () => {
    const { id } = await requestDeletion(apiReq, t.dev.id, { userId: "nobody" });
    const otherKey = await createApiKey(other.ctx, other.dev.id, { label: "x" });
    const p = (await authenticateIngestionKey(otherKey.key))!;
    await expect(getDeletion({ kind: "api_key", organizationId: p.organizationId, environmentId: p.environmentId, keyId: p.keyId }, p.environmentId, id)).rejects.toThrow(/not found/i);
    await expect(getDeletion(apiReq, t.dev.id, "not-a-uuid")).rejects.toThrow(/not found/i);
  });

  it("records a generic error on failure, keeping the database's message out of the job row", async () => {
    const { id, jobId } = await requestDeletion(apiReq, t.dev.id, { userId: "nobody-fails" });
    await withSystem((db) => db.query("revoke delete on platform.events from platform_app"));
    try {
      expect(await runDeletionJobs({ jobIds: [jobId] })).toEqual({ completed: 0, failed: 1 });
    } finally {
      await withSystem((db) => db.query("grant delete on platform.events to platform_app"));
    }
    const d = await getDeletion(apiReq, t.dev.id, id);
    expect(d.job).toMatchObject({ status: "queued", error: "internal_error" });
    expect((await listPrivacyRequests(t.ctx, t.dev.id)).find((r) => r.id === id)?.error).toBe("internal_error");
  });

  it("the cron worker picks up queued jobs and retries a crashed run", async () => {
    const { id, jobId } = await requestDeletion(apiReq, t.dev.id, { userId: "u2" });
    await withSystem((db) => db.query("update platform.data_deletion_jobs set status = 'running', started_at = now() - interval '1 hour', attempts = 1 where id = $1", [jobId]));
    const r = await runDeletionJobs({ limit: 50 });
    expect(r.completed).toBeGreaterThanOrEqual(1);
    const d = await getDeletion(apiReq, t.dev.id, id);
    expect(d.status).toBe("completed");
    expect(d.job!.attempts).toBe(2);
    expect(await eventsFor(t.dev.id, "user_id = 'u2'")).toBe(0);
  });
});

describe("API authentication", () => {
  const req = (key: string) => new Request("http://x/v1/privacy/deletions", { method: "POST", headers: { Authorization: `Bearer ${key}` } });
  it("needs a secret key", async () => {
    await expect(apiSecretKey(req(t.sdkKey), "privacy:write")).rejects.toThrow(/secret API key/);
    await expect(apiSecretKey(req("la_sk_dev_nope"), "privacy:write")).rejects.toThrow(/invalid/);
  });

  it("needs the scope the endpoint asks for", async () => {
    const events = await createApiKey(t.ctx, t.dev.id, { label: "events only" });
    await expect(apiSecretKey(req(events.key), "privacy:read")).rejects.toThrow(/privacy:read permission/);
    await expect(apiSecretKey(req(events.key), "privacy:write")).rejects.toThrow(/privacy:write permission/);

    const reader = await createApiKey(t.ctx, t.dev.id, { label: "dsar", scopes: ["privacy:read"] });
    expect((await apiSecretKey(req(reader.key), "privacy:read")).scopes).toEqual(["privacy:read"]);
    await expect(apiSecretKey(req(reader.key), "privacy:write")).rejects.toThrow(/privacy:write/);

    const both = await createApiKey(t.ctx, t.dev.id, { scopes: ["privacy:read", "privacy:write", "privacy:read"] });
    expect((await apiSecretKey(req(both.key), "privacy:write")).scopes).toEqual(["privacy:read", "privacy:write"]);

    await expect(createApiKey(t.ctx, t.dev.id, { scopes: [] })).rejects.toThrow(/at least one/);
    await expect(createApiKey(t.ctx, t.dev.id, { scopes: ["admin"] })).rejects.toThrow(/Unknown scope/);
  });
});

describe("dashboard export download", () => {
  const url = () => `http://app.test/o/${t.org.slug}/apps/${t.app.slug}/privacy/export`;
  const call = async (headers: Record<string, string>) => {
    const { token } = await signIn({ email: t.user.email, password: "correct-horse-9" }, { ip: "10.3.0.1" });
    const body = new URLSearchParams({ environment: t.dev.id, user_id: "u2", anonymous_id: "" });
    const r = new Request(url(), { method: "POST", body, headers: { host: "app.test", cookie: `${SESSION_COOKIE}=${token}`, ...headers } });
    return exportRoute.POST(r, { params: Promise.resolve({ org: t.org.slug, app: t.app.slug }) });
  };

  it("is a same-origin form POST that downloads the file", async () => {
    expect("GET" in exportRoute).toBe(false);
    expect((await call({})).status).toBe(403); // no Origin
    expect((await call({ origin: "https://evil.example" })).status).toBe(403);
    expect((await call({ origin: "http://app.test", "sec-fetch-site": "cross-site" })).status).toBe(403);
    const ok = await call({ origin: "http://app.test", "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment; filename="leanapp-export-/);
    expect((await ok.json()).subject.user_id).toBe("u2");
  });
});
