/**
 * Consent capture and suppression lists against Postgres: consent events at
 * ingestion, server-side drop of users who denied analytics, stitching across
 * user and install ids, automatic and manual suppressions, the API and its
 * scopes, export / deletion, permissions and tenant isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, createApiKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { connectionHealth } from "@/modules/debugger/service";
import { ingest, type IngestResponse } from "@/modules/ingestion/service";
import {
  addSuppression,
  consentOverview,
  consentState,
  isSuppressed,
  listSuppressions,
  lookupConsent,
  removeSuppression,
  suppressedKeys,
} from "@/modules/privacy/consent";
import { exportSubjectData, requestDeletion, runDeletionJobs, type Requester } from "@/modules/privacy/service";
import { processPendingEvents } from "@/modules/processing/processor";
import * as consentRoute from "@/app/v1/privacy/consent/route";
import * as suppressionsRoute from "@/app/v1/privacy/suppressions/route";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;
let otherSdk: IngestionPrincipal;
let apiReq: Requester;
let writerKey: string;
let readerKey: string;
let eventsKey: string;

const track = (o: Record<string, unknown>) => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), ...o });
const consent = (o: Record<string, unknown>) => ({ type: "consent", event_id: crypto.randomUUID(), ...o });
const send = async (p: IngestionPrincipal, batch: unknown[]) => {
  const r = await ingest(p, { batch }, { mode: "batch" });
  expect(r.status).toBe(200);
  return r.body as IngestResponse;
};

async function n(sql: string, values: unknown[]) {
  const row = await withSystem((db) => db.one<{ n: string }>(sql, values));
  return Number(row!.n);
}
const stored = (env: string, where: string, values: unknown[] = []) => n(`select count(*) as n from platform.events where environment_id = $1 and ${where}`, [env, ...values]);

beforeAll(async () => {
  t = await makeTenant("consent");
  other = await makeTenant("consent-other");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;
  otherSdk = (await authenticateIngestionKey(other.sdkKey))!;
  const writer = await createApiKey(t.ctx, t.dev.id, { label: "w", scopes: ["privacy:write", "privacy:read"] });
  writerKey = writer.key;
  readerKey = (await createApiKey(t.ctx, t.dev.id, { label: "r", scopes: ["privacy:read"] })).key;
  eventsKey = (await createApiKey(t.ctx, t.dev.id, { label: "e" })).key;
  const p = (await authenticateIngestionKey(writer.key))!;
  apiReq = { kind: "api_key", organizationId: p.organizationId, environmentId: p.environmentId, keyId: p.keyId };
});

describe("consent events", () => {
  it("are recorded under both keys, not stored as events, and idempotent", async () => {
    const c = consent({ anonymous_id: "c1", user_id: "cu1", consent: { analytics: true, marketing: false } });
    const body = await send(sdk, [c]);
    expect(body).toMatchObject({ accepted: 1, duplicates: 0, rejected: [] });
    expect(await stored(t.dev.id, "type = 'consent' or event_name = 'consent_updated'")).toBe(0);
    expect(await n("select count(*) as n from platform.consent_records where environment_id = $1 and event_id = $2", [t.dev.id, c.event_id])).toBe(2);
    const rec = await withSystem((db) => db.one<{ user_key: string; source: string; anonymous_id: string }>(
      "select user_key, source, anonymous_id from platform.consent_records where event_id = $1 limit 1", [c.event_id]));
    expect(rec).toMatchObject({ user_key: "cu1", source: "sdk", anonymous_id: "c1" });

    // A retry is a duplicate and records nothing new.
    expect(await send(sdk, [c])).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(await n("select count(*) as n from platform.consent_records where event_id = $1", [c.event_id])).toBe(2);

    for (const key of ["cu1", "anon:c1"]) {
      expect(await consentState(t.dev.id, key)).toMatchObject({ analytics: true, marketing: false, push: null, attribution: null });
    }
    // The usage meter counts stored events only.
    expect(await n("select coalesce(sum(quantity), 0) as n from platform.usage_records where organization_id = $1", [t.org.id])).toBe(0);
  });

  it("validates the consent payload", async () => {
    const body = await send(sdk, [
      consent({ anonymous_id: "bad" }),
      consent({ anonymous_id: "bad", consent: {} }),
      consent({ anonymous_id: "bad", consent: { analytics: "yes" } }),
      consent({ anonymous_id: "bad", consent: { tracking: true } }),
    ]);
    expect(body.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3]);
    expect(body.rejected.every((r) => !r.reason)).toBe(true);
  });

  it("from a secret key are recorded with source api", async () => {
    const backend = (await authenticateIngestionKey(eventsKey))!;
    const c = consent({ user_id: "backend-user", consent: { push: false } });
    expect((await ingest(backend, c, { mode: "single" })).status).toBe(200);
    expect(await n("select count(*) as n from platform.consent_records where event_id = $1 and source = 'api' and user_key = 'backend-user'", [c.event_id])).toBe(1);
    expect(await isSuppressed(t.dev.id, "backend-user", "push")).toBe(true);
  });
});

describe("server-side enforcement", () => {
  it("drops events of a user who denied analytics and reports consent_denied", async () => {
    const body = await send(sdk, [
      track({ anonymous_id: "d1" }), // before the denial in the same batch: dropped too (state after the batch's changes)
      consent({ anonymous_id: "d1", consent: { analytics: false } }),
      track({ anonymous_id: "d1" }),
      track({ anonymous_id: "d2" }),
    ]);
    expect(body.accepted).toBe(2); // the consent change and d2's event
    expect(body.rejected).toEqual([
      expect.objectContaining({ index: 0, reason: "consent_denied" }),
      expect.objectContaining({ index: 2, reason: "consent_denied" }),
    ]);
    expect(await stored(t.dev.id, "anonymous_id = 'd1'")).toBe(0);
    expect(await stored(t.dev.id, "anonymous_id = 'd2'")).toBe(1);
    const batch = await withSystem((db) => db.one<{ rejected_count: number; consent_denied_count: number }>(
      "select rejected_count, consent_denied_count from platform.event_batches where id = $1", [body.batch_id]));
    expect(batch).toEqual({ rejected_count: 2, consent_denied_count: 2 });

    const health = await connectionHealth(t.ctx, t.dev.id);
    expect(health.consentDeniedToday).toBeGreaterThanOrEqual(2);
    expect(health.rejectedToday).toBeGreaterThanOrEqual(health.consentDeniedToday);
  });

  it("a single dropped event is not a client error", async () => {
    const r = await ingest(sdk, track({ anonymous_id: "d1" }), { mode: "single" });
    expect(r.status).toBe(200);
    expect((r.body as IngestResponse).rejected[0].reason).toBe("consent_denied");
  });

  it("stitches the install's decision to the identified user and lets the latest decision win", async () => {
    // Denied while anonymous; after login the events carry both ids and are still dropped.
    await send(sdk, [consent({ anonymous_id: "s1", consent: { analytics: false } })]);
    let body = await send(sdk, [track({ anonymous_id: "s1", user_id: "su1" })]);
    expect(body.rejected[0]?.reason).toBe("consent_denied");

    // Granted later (while logged in): both keys now say granted.
    await send(sdk, [consent({ anonymous_id: "s1", user_id: "su1", consent: { analytics: true }, timestamp: new Date(Date.now() + 1000).toISOString() })]);
    body = await send(sdk, [track({ anonymous_id: "s1", user_id: "su1" }), track({ user_id: "su1" }), track({ anonymous_id: "s1" })]);
    expect(body.accepted).toBe(3);

    // A late retry of an older decision never overrides a newer one.
    await send(sdk, [consent({ anonymous_id: "s1", user_id: "su1", consent: { analytics: false }, timestamp: new Date(Date.now() - 60_000).toISOString() })]);
    expect((await consentState(t.dev.id, "su1")).analytics).toBe(true);
    expect((await send(sdk, [track({ user_id: "su1" })])).accepted).toBe(1);

    // A backend denial under the user id alone wins over the install's older grant.
    const backend = (await authenticateIngestionKey(eventsKey))!;
    await ingest(backend, consent({ user_id: "su1", consent: { analytics: false }, timestamp: new Date(Date.now() + 5000).toISOString() }), { mode: "single" });
    body = await send(sdk, [track({ anonymous_id: "s1", user_id: "su1" }), track({ anonymous_id: "s1" })]);
    expect(body.rejected.map((r) => r.index)).toEqual([0]); // the install alone is still granted
  });

  it("removes attribution context when attribution is denied", async () => {
    await send(sdk, [consent({ anonymous_id: "at1", consent: { attribution: false } })]);
    const e = track({ anonymous_id: "at1", context: { attribution: { utm_source: "tiktok" }, platform: "ios" } });
    await send(sdk, [e]);
    const row = await withSystem((db) => db.one<{ context: Record<string, unknown> }>("select context from platform.events where event_id = $1", [e.event_id]));
    expect(row!.context.attribution).toBeUndefined();
    expect(row!.context.platform).toBe("ios");
  });

  it("is per environment and per tenant", async () => {
    // d1 denied in t's development environment only.
    const prod = t.environments.find((e) => e.type === "production")!;
    expect(await consentState(prod.id, "anon:d1")).toMatchObject({ analytics: null });
    expect((await send(otherSdk, [track({ anonymous_id: "d1" })])).accepted).toBe(1);
    expect(await consentState(other.dev.id, "anon:d1")).toMatchObject({ analytics: null });
  });
});

describe("suppression", () => {
  it("follows marketing and push consent automatically", async () => {
    await send(sdk, [consent({ anonymous_id: "m1", user_id: "mu1", consent: { marketing: false, push: false } })]);
    expect(await isSuppressed(t.dev.id, "mu1", "marketing")).toBe(true);
    expect(await isSuppressed(t.dev.id, "mu1", "push")).toBe(true);
    expect(await isSuppressed(t.dev.id, "anon:m1", "marketing")).toBe(true);
    expect(await isSuppressed(t.dev.id, "mu1", "email")).toBe(false);
    expect([...(await suppressedKeys(t.dev.id, ["mu1", "nobody", "anon:m1"], "marketing"))].sort()).toEqual(["anon:m1", "mu1"]);

    // A manual entry survives a re-grant; the automatic one goes.
    await addSuppression({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: "mu1", channels: ["marketing"], reason: "asked support" });
    await send(sdk, [consent({ anonymous_id: "m1", user_id: "mu1", consent: { marketing: true, push: true }, timestamp: new Date(Date.now() + 1000).toISOString() })]);
    expect(await isSuppressed(t.dev.id, "mu1", "push")).toBe(false);
    expect(await isSuppressed(t.dev.id, "anon:m1", "marketing")).toBe(false);
    expect(await isSuppressed(t.dev.id, "mu1", "marketing")).toBe(true);
    const rows = (await listSuppressions({ kind: "user", ctx: t.ctx }, t.dev.id, { userKey: "mu1" })).rows;
    expect(rows.map((r) => [r.channel, r.source, r.reason])).toEqual([["marketing", "manual", "asked support"]]);
  });

  it("manual removal leaves consent-driven entries in place", async () => {
    await send(sdk, [consent({ user_id: "mu2", anonymous_id: "m2", consent: { marketing: false } })]);
    await addSuppression(apiReq, t.dev.id, { userId: "mu2", channels: ["marketing", "email"] });
    const r = await removeSuppression(apiReq, t.dev.id, { userId: "mu2", channels: ["marketing", "email"] });
    expect(r).toEqual({ userKey: "mu2", removed: 2, remaining: ["marketing"] });
    expect(await isSuppressed(t.dev.id, "mu2", "marketing")).toBe(true);
    expect(await isSuppressed(t.dev.id, "mu2", "email")).toBe(false);
    const audit = await withSystem((db) => db.query<{ action: string; actor_type: string }>(
      "select action, actor_type from platform.audit_logs where organization_id = $1 and action like 'privacy.suppression%'", [t.org.id]));
    expect(audit).toEqual(expect.arrayContaining([
      { action: "privacy.suppression_added", actor_type: "user" },
      { action: "privacy.suppression_added", actor_type: "api_key" },
      { action: "privacy.suppression_removed", actor_type: "api_key" },
    ]));
  });

  it("validates input and pages the list", async () => {
    await expect(addSuppression(apiReq, t.dev.id, { userId: "x", channels: ["fax"] })).rejects.toThrow();
    await expect(addSuppression(apiReq, t.dev.id, { channels: ["push"] })).rejects.toThrow(/user_id/);
    for (let i = 0; i < 5; i++) await addSuppression(apiReq, t.dev.id, { userId: `page-${i}`, channels: ["email"] });
    const first = await listSuppressions(apiReq, t.dev.id, { channel: "email", limit: 3 });
    expect(first.rows).toHaveLength(3);
    const second = await listSuppressions(apiReq, t.dev.id, { channel: "email", limit: 3, before: first.cursor! });
    const keys = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    await expect(listSuppressions(apiReq, t.dev.id, { before: "garbage" })).rejects.toThrow(/cursor/);
  });

  it("needs privacy.manage and stays inside the tenant and environment", async () => {
    await expect(addSuppression({ kind: "user", ctx: { ...t.ctx, role: "marketer" } }, t.dev.id, { userId: "x", channels: ["push"] })).rejects.toThrow(/permission/);
    await expect(lookupConsent({ kind: "user", ctx: { ...t.ctx, role: "developer" } }, t.dev.id, { userId: "x" })).rejects.toThrow(/permission/);
    await expect(consentOverview({ ...t.ctx, role: "analyst" }, t.dev.id)).rejects.toThrow(/permission/);
    // Another organization's environment is invisible; a key can't reach another environment.
    await expect(addSuppression({ kind: "user", ctx: t.ctx }, other.dev.id, { userId: "x", channels: ["push"] })).rejects.toThrow(/not found/i);
    await expect(listSuppressions({ kind: "user", ctx: other.ctx }, t.dev.id)).rejects.toThrow(/not found/i);
    const prod = t.environments.find((e) => e.type === "production")!;
    await expect(addSuppression(apiReq, prod.id, { userId: "x", channels: ["push"] })).rejects.toThrow(/not found/i);
    await addSuppression({ kind: "user", ctx: other.ctx }, other.dev.id, { userId: "mu1", channels: ["email"] });
    expect(await isSuppressed(t.dev.id, "mu1", "email")).toBe(false);
    expect(await isSuppressed(other.dev.id, "mu1", "email")).toBe(true);
    // RLS: the other tenant can't see t's rows even without a filter.
    const seen = await import("@/lib/db").then(({ withTenant }) =>
      withTenant({ organizationId: other.org.id, userId: null }, (db) => db.query<{ user_key: string }>("select user_key from platform.suppressions union all select user_key from platform.consent_state")),
    );
    expect(seen.every((r) => r.user_key === "mu1")).toBe(true);
  });
});

describe("API", () => {
  const req = (method: string, path: string, key: string, body?: unknown) =>
    new Request(`http://x${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

  it("adds, lists and removes suppressions with privacy:write / privacy:read", async () => {
    let r = await suppressionsRoute.POST(req("POST", "/v1/privacy/suppressions", writerKey, { user_id: "api-u1", channel: "push", reason: "unsubscribed" }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ user_key: "api-u1", channels: ["push"], suppressed: true });
    r = await suppressionsRoute.GET(req("GET", "/v1/privacy/suppressions?user_id=api-u1", readerKey));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual([expect.objectContaining({ user_key: "api-u1", channel: "push", source: "api", reason: "unsubscribed" })]);
    r = await suppressionsRoute.DELETE(req("DELETE", "/v1/privacy/suppressions?user_id=api-u1&channel=push", writerKey));
    expect(await r.json()).toEqual({ user_key: "api-u1", removed: 1, still_suppressed_by_consent: [] });
  });

  it("refuses keys without the scope and public keys", async () => {
    expect((await suppressionsRoute.POST(req("POST", "/v1/privacy/suppressions", readerKey, { user_id: "x", channel: "push" }))).status).toBe(403);
    expect((await suppressionsRoute.DELETE(req("DELETE", "/v1/privacy/suppressions?user_id=x&channel=push", eventsKey))).status).toBe(403);
    expect((await suppressionsRoute.GET(req("GET", "/v1/privacy/suppressions", eventsKey))).status).toBe(403);
    expect((await suppressionsRoute.GET(req("GET", "/v1/privacy/suppressions", t.sdkKey))).status).toBe(403);
    expect((await consentRoute.GET(req("GET", "/v1/privacy/consent?user_id=x", t.sdkKey))).status).toBe(403);
    expect((await suppressionsRoute.POST(req("POST", "/v1/privacy/suppressions", writerKey, { user_id: "x", channel: "fax" }))).status).toBe(422);
  });

  it("returns a user's current consent and history", async () => {
    const r = await consentRoute.GET(req("GET", "/v1/privacy/consent?user_id=mu1&anonymous_id=m1", readerKey));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.user_keys).toEqual(["mu1", "anon:m1"]);
    expect(body.consent).toEqual({ analytics: null, marketing: true, push: true, attribution: null });
    expect(body.history.length).toBe(4);
    expect(body.suppressions).toEqual([expect.objectContaining({ channel: "marketing", source: "manual" })]);
    expect((await consentRoute.GET(req("GET", "/v1/privacy/consent", readerKey))).status).toBe(422);
  });
});

describe("dashboard", () => {
  it("overview counts granted, denied and installs with no decision per day", async () => {
    await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
    const points = await consentOverview(t.ctx, t.dev.id, 7);
    expect(points).toHaveLength(7 * 4);
    const today = (p: string) => points.filter((x) => x.purpose === p).at(-1)!;
    // analytics: c1 granted, s1 granted (its latest), d1 denied, su1 (backend, no install) denied.
    expect(today("analytics")).toMatchObject({ granted: 2, denied: 2 });
    // Installs that sent events with no analytics decision: d2, at1, ... (s1, c1 have one).
    expect(today("analytics").pending).toBeGreaterThanOrEqual(2);
    expect(today("marketing")).toMatchObject({ granted: 1, denied: 2 }); // m1 regranted; c1, m2 denied
  });

  it("looks up one user's state, history and suppressions", async () => {
    const l = await lookupConsent({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: "su1", anonymousId: "s1" });
    expect(l.state.analytics).toBe(false); // the backend's later denial
    expect(l.history.length).toBeGreaterThanOrEqual(4);
    expect(l.history[0].granted).toBe(false);
  });
});

describe("export and deletion", () => {
  it("exports the subject's consent and suppressions and deletes them, keeping a shared install's", async () => {
    // e1: the user's own phone. e2: shared with another user, whose consent is kept.
    await send(sdk, [
      track({ type: "identify", anonymous_id: "e1", user_id: "eu1" }),
      track({ type: "identify", anonymous_id: "e2", user_id: "eu1" }),
      track({ type: "identify", anonymous_id: "e2", user_id: "eu2" }),
      consent({ anonymous_id: "e1", consent: { marketing: false } }),
      consent({ anonymous_id: "e1", user_id: "eu1", consent: { analytics: true } }),
      consent({ anonymous_id: "e2", consent: { analytics: true } }),
      consent({ anonymous_id: "e2", user_id: "eu2", consent: { analytics: true } }),
    ]);
    await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
    await addSuppression(apiReq, t.dev.id, { userId: "eu1", channels: ["email"] });

    const x = await exportSubjectData(apiReq, t.dev.id, { userId: "eu1" });
    expect(x.subject.matched_anonymous_ids).toEqual(["e1"]);
    const recs = x.data.consent_records as { user_key: string; purpose: string }[];
    expect(recs.map((r) => `${r.user_key}:${r.purpose}`).sort()).toEqual(["anon:e1:marketing", "eu1:analytics"]);
    expect((x.data.consent_state as { user_key: string }[]).map((r) => r.user_key).sort()).toEqual(["anon:e1", "anon:e1", "eu1"]);
    expect((x.data.suppressions as { user_key: string; channel: string }[]).map((r) => `${r.user_key}:${r.channel}`).sort()).toEqual(["anon:e1:marketing", "eu1:email"]);

    const { jobId } = await requestDeletion(apiReq, t.dev.id, { userId: "eu1", anonymousId: "e2" });
    await runDeletionJobs({ jobIds: [jobId] });
    const left = (key: string, table: string) => n(`select count(*) as n from platform.${table} where environment_id = $1 and user_key = $2`, [t.dev.id, key]);
    for (const table of ["consent_records", "consent_state", "suppressions"]) {
      expect(await left("eu1", table)).toBe(0);
      expect(await left("anon:e1", table)).toBe(0);
    }
    // e2 is shared with eu2: its install-level consent and eu2's own are untouched.
    expect(await left("anon:e2", "consent_records")).toBe(1);
    expect(await left("eu2", "consent_state")).toBe(1);
    expect(await left("anon:e2", "consent_state")).toBe(1);
  });
});
