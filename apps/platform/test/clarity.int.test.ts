/**
 * Microsoft Clarity (modules/integrations/clarity*.ts): connection with an
 * encrypted Data Export token, the daily metrics import within Clarity's 10
 * requests per project per day, per-capability status, the profile link,
 * RBAC, audit and tenant isolation.
 *
 * Clarity's API is a local fake (fetchImpl) shaped like Microsoft's
 * documented sample: these are simulated tests, not verification against
 * Clarity.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  clarityImportNow, clarityProfileLink, clarityView, runClarityImport, runClaritySyncJobs, saveClarityConnection, setClarityImport,
} from "@/modules/integrations/clarity-service";
import { centerData, listConnections, removeConnection } from "@/modules/integrations/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
const TOKEN = "clarity-secret-token-abc";
const NOW = new Date("2026-10-09T10:00:00Z");

let mode: "ok" | "unauthorized" | "limit" | "garbage" = "ok";
const calls: { url: string; auth: string | null }[] = [];
const clarityFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null });
  if (mode === "unauthorized") return new Response("", { status: 401 });
  if (mode === "limit") return new Response("Exceeded daily limit", { status: 429 });
  if (mode === "garbage") return Response.json({ unexpected: true });
  const dim = new URL(url).searchParams.get("dimension1")!;
  const values: Record<string, string[]> = { URL: ["https://shop.example/", "https://shop.example/cart?email=a@b.c"], Device: ["PC", "Mobile"], Source: ["google", "instagram"] };
  return Response.json([
    { metricName: "Traffic", information: values[dim].map((v, i) => ({ totalSessionCount: String(100 * (i + 1)), totalBotSessionCount: "3", distantUserCount: "50", PagesPerSessionPercentage: 1.5, [dim]: v })) },
    { metricName: "Rage Click Count", information: values[dim].map((v) => ({ sessionsCount: "4", sessionsWithMetricPercentage: 2.5, subTotal: "6", [dim]: v })) },
    { metricName: "Scroll Depth", information: values[dim].map((v) => ({ averageScrollDepth: 61.2, [dim]: v })) },
  ]);
}) as unknown as typeof fetch;
const http = { fetchImpl: clarityFetch, baseDelayMs: 0, sleep: async () => {} };

const as = (t: T, role: TenantContext["role"]): TenantContext => ({ ...t.ctx, role });

beforeAll(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "c".repeat(64);
  A = await makeTenant("clarity");
  B = await makeTenant("clarity-b");
});

describe("Clarity connection", () => {
  it("stores the token encrypted and out of the tenant role's reach, and keeps it when the field is left blank", async () => {
    await expect(saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, projectId: "../evil" })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, apiToken: "has spaces in it" })).rejects.toBeInstanceOf(ValidationError);
    const first = await saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, projectId: "3T0WLOGVDZ" });
    expect(first.missing).toEqual(["Data Export API token"]);
    const r = await saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, projectId: "3t0wlogvdz", apiToken: TOKEN });
    expect(r).toEqual({ id: first.id, missing: [] });
    const raw = await withSystem((db) => db.one<{ credentials_enc: string }>("select credentials_enc from platform.integration_connections where id = $1", [r.id]));
    expect(raw!.credentials_enc).not.toContain(TOKEN);
    await expect(withTenant({ organizationId: A.org.id, userId: A.user.id }, (db) => db.query("select credentials_enc from platform.integration_connections"))).rejects.toThrow(/permission denied/);

    await saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, projectId: "3t0wlogvdz", apiToken: "" });
    const conn = (await listConnections(A.ctx, A.app.id, A.dev.id)).find((c) => c.provider === "microsoft_clarity")!;
    expect(conn).toMatchObject({ has_credentials: true, missing_fields: [], config: { project_id: "3t0wlogvdz" } });
    // Saving starts nothing: the import capability exists, turned off.
    expect(conn.capabilities.map((c) => [c.capability, c.enabled, c.status])).toEqual([["clarity_metrics_import", false, "not_configured"]]);

    const audits = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from platform.audit_logs where target_id = $1 and action = 'integration.connection_saved'", [r.id]));
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it("needs integrations.manage to change and integrations.read to see", async () => {
    await expect(saveClarityConnection(as(A, "marketer"), A.app.id, { environmentId: A.dev.id, apiToken: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(clarityView(as(A, "viewer"), A.app.id, A.dev.id, "URL")).rejects.toBeInstanceOf(ForbiddenError);
    const v = await clarityView(as(A, "marketer"), A.app.id, A.dev.id, "URL");
    expect(v.connection?.provider).toBe("microsoft_clarity");
  });

  it("refuses Import now until the daily import is on", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    await expect(clarityImportNow(A.ctx, A.app.id, conn.id, 1, { http, now: NOW })).rejects.toBeInstanceOf(ValidationError);
    await setClarityImport(A.ctx, A.app.id, conn.id, true);
    const v = await clarityView(A.ctx, A.app.id, A.dev.id, "URL");
    expect(v.connection!.capabilities[0]).toMatchObject({ enabled: true, status: "unverified" });
    await expect(clarityImportNow(A.ctx, A.app.id, conn.id, 4, { http, now: NOW })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Clarity metrics import", () => {
  it("imports one snapshot per dimension with the token as a bearer header, and marks the capability verified", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    calls.length = 0;
    const r = await clarityImportNow(A.ctx, A.app.id, conn.id, 1, { http, now: NOW });
    expect(r).toEqual({ ok: true, rows: 18, requests: 3, snapshotDate: "2026-10-09" });
    expect(calls.map((c) => new URL(c.url).searchParams.toString())).toEqual(["numOfDays=1&dimension1=URL", "numOfDays=1&dimension1=Device", "numOfDays=1&dimension1=Source"]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN))).toBe(true);

    const v = await clarityView(A.ctx, A.app.id, A.dev.id, "URL", { now: NOW });
    expect(v.snapshot).toMatchObject({ snapshot_date: "2026-10-09", num_of_days: 1 });
    // Query strings never stored; rows ordered by sessions.
    expect(v.rows.map((x) => x.value)).toEqual(["https://shop.example/cart", "https://shop.example/"]);
    expect(v.rows[0].metrics.Traffic).toEqual({ totalSessionCount: 200, totalBotSessionCount: 3, distantUserCount: 50, PagesPerSessionPercentage: 1.5 });
    expect(v.metrics.sort()).toEqual(["Rage Click Count", "Scroll Depth", "Traffic"]);
    expect(v.usedToday).toBe(3);
    expect(v.history).toEqual([{ snapshot_date: "2026-10-09", num_of_days: 1, sessions: 300 }]);
    expect(v.connection!.capabilities[0]).toMatchObject({ status: "verified", data_fresh_through: "2026-10-09", last_error: null });
    // Next scheduled run: the next UTC day.
    expect(new Date(v.connection!.capabilities[0].next_sync_at!).toISOString()).toBe("2026-10-10T01:00:00.000Z");

    // The center reports the three capabilities separately.
    const center = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(center.connections.find((c) => c.provider === "microsoft_clarity")!.config).toEqual({ project_id: "3t0wlogvdz" });
  });

  it("re-importing the same day replaces the snapshot instead of adding to it", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    const r = await runClarityImport(conn.id, { manual: true, http, now: new Date("2026-10-09T12:00:00Z") });
    expect(r.ok).toBe(true);
    const n = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.clarity_insights where connection_id = $1", [conn.id]));
    expect(n!.n).toBe("18");
  });

  it("keeps within 10 requests a day: a third import doesn't start, and makes no request", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    // 6 used so far today; one more import fits (9), the next doesn't (12 > 10).
    expect((await runClarityImport(conn.id, { manual: true, http, now: new Date("2026-10-09T13:00:00Z") })).ok).toBe(true);
    calls.length = 0;
    const r = await clarityImportNow(A.ctx, A.app.id, conn.id, 1, { http, now: new Date("2026-10-09T14:00:00Z") });
    expect(r).toMatchObject({ ok: false, budgetExhausted: true, requests: 0 });
    expect(calls).toEqual([]);
    const v = await clarityView(A.ctx, A.app.id, A.dev.id, "URL", { now: new Date("2026-10-09T14:00:00Z") });
    expect(v.usedToday).toBe(9);
    // Not an error from Clarity: the capability stays verified.
    expect(v.connection!.capabilities[0].status).toBe("verified");
    // The next UTC day has a fresh budget.
    expect((await runClarityImport(conn.id, { manual: true, http, now: new Date("2026-10-10T00:30:00Z") })).ok).toBe(true);
  });

  it("stops at the first failure: a bad token waits for new credentials, the daily limit waits for tomorrow", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    mode = "unauthorized";
    calls.length = 0;
    const bad = await runClarityImport(conn.id, { http, now: new Date("2026-10-11T02:00:00Z") });
    expect(bad).toMatchObject({ ok: false, errorKind: "auth", requests: 1 });
    expect(calls).toHaveLength(1);
    let cap = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!.capabilities[0];
    expect(cap).toMatchObject({ status: "error", next_sync_at: null, last_error: expect.stringContaining("401") });
    expect(cap.last_error).not.toContain(TOKEN);

    // A new token clears the error and schedules the import again.
    await saveClarityConnection(A.ctx, A.app.id, { environmentId: A.dev.id, projectId: "3t0wlogvdz", apiToken: "new-token" });
    cap = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!.capabilities[0];
    expect(cap.last_error).toBeNull();
    expect(cap.next_sync_at).not.toBeNull();

    mode = "limit";
    const limited = await runClarityImport(conn.id, { http, now: new Date("2026-10-11T03:00:00Z") });
    expect(limited).toMatchObject({ ok: false, errorKind: "rate_limited" });
    cap = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!.capabilities[0];
    expect(new Date(cap.next_sync_at!).toISOString()).toBe("2026-10-12T01:00:00.000Z");

    mode = "garbage";
    const garbage = await runClarityImport(conn.id, { http, now: new Date("2026-10-11T04:00:00Z") });
    expect(garbage).toMatchObject({ ok: false, errorKind: "permanent", error: expect.stringContaining("unexpected format") });
    mode = "ok";
    const runs = await withSystem((db) => db.query<{ status: string; requests: number }>(
      "select status, requests from platform.integration_sync_runs where connection_id = $1 and started_at >= '2026-10-11' order by started_at", [conn.id]));
    expect(runs).toEqual([{ status: "failed", requests: 1 }, { status: "failed", requests: 1 }, { status: "failed", requests: 1 }]);
  });

  it("runs from the scheduled worker only when due", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    await withSystem((db) => db.query("update platform.integration_capabilities set next_sync_at = now() + interval '1 day' where connection_id = $1", [conn.id]));
    expect(await runClaritySyncJobs({ http })).toEqual({ imported: 0, failed: 0, skipped: 0 });
    await withSystem((db) => db.query("update platform.integration_capabilities set next_sync_at = now() - interval '1 minute' where connection_id = $1", [conn.id]));
    expect(await runClaritySyncJobs({ http, now: new Date("2026-10-13T01:00:00Z") })).toEqual({ imported: 1, failed: 0, skipped: 0 });
    // Turned off: never claimed.
    await setClarityImport(A.ctx, A.app.id, conn.id, false);
    await withSystem((db) => db.query("update platform.integration_capabilities set next_sync_at = now() - interval '1 minute' where connection_id = $1", [conn.id]));
    expect(await runClaritySyncJobs({ http, now: new Date("2026-10-14T01:00:00Z") })).toEqual({ imported: 0, failed: 0, skipped: 0 });
    await setClarityImport(A.ctx, A.app.id, conn.id, true);
  });
});

describe("profile link and isolation", () => {
  it("gives profiles a link to the project when a project id is set (users.read)", async () => {
    expect(await clarityProfileLink(as(A, "viewer"), A.app.id, A.dev.id)).toEqual({ projectId: "3t0wlogvdz", url: "https://clarity.microsoft.com/projects/view/3t0wlogvdz/dashboard" });
    const prod = A.environments.find((e) => e.type === "production")!;
    expect(await clarityProfileLink(A.ctx, A.app.id, prod.id)).toBeNull();
  });

  it("keeps tenants apart", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    await expect(clarityView(B.ctx, B.app.id, A.dev.id, "URL")).rejects.toBeInstanceOf(NotFoundError);
    await expect(setClarityImport(B.ctx, B.app.id, conn.id, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(clarityImportNow(B.ctx, B.app.id, conn.id, 1, { http })).rejects.toBeInstanceOf(NotFoundError);
    await expect(clarityProfileLink(B.ctx, B.app.id, A.dev.id)).rejects.toBeInstanceOf(NotFoundError);
    const seen = await withTenant({ organizationId: B.org.id, userId: B.user.id }, (db) => db.query("select id from platform.clarity_insights"));
    expect(seen).toEqual([]);
    expect((await clarityView(B.ctx, B.app.id, B.dev.id, "URL")).connection).toBeNull();
  });

  it("removing the connection removes its imported metrics", async () => {
    const conn = (await clarityView(A.ctx, A.app.id, A.dev.id, "URL")).connection!;
    await removeConnection(A.ctx, A.app.id, conn.id);
    const n = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.clarity_insights where connection_id = $1", [conn.id]));
    expect(n!.n).toBe("0");
    expect(await clarityProfileLink(A.ctx, A.app.id, A.dev.id)).toBeNull();
  });
});
