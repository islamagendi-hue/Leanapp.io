/**
 * Integrations Center (modules/integrations): ad connections with encrypted
 * credentials, per-capability status, ad reporting sync with spend import
 * into Ad spend, backfill, OAuth state (CSRF), RBAC and tenant isolation;
 * and outbound conversion checks in postback delivery (consent, match keys,
 * provider error reporting).
 *
 * Every provider API is a local fake (fetchImpl): these are simulated tests,
 * not verification against Meta, Google, TikTok or Snap.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { deliverPostbacks } from "@/modules/attribution/delivery";
import { createLink, createPostback, handleClick } from "@/modules/attribution/service";
import { listSpend, saveSpend } from "@/modules/attribution/spend";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { consumeOAuthState, listConnections, removeConnection, requestBackfill, saveAdConnection, setCapability, startOAuth, syncNow, verifyConnection, centerData, completeOAuth } from "@/modules/integrations/service";
import { runAdSyncJobs, syncConnection } from "@/modules/integrations/sync";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
const TODAY = "2026-10-09";

/** A fake Meta Graph API: one account, one row per day requested. `mode` switches failures on. */
let mode: "ok" | "expired" | "throttled" = "ok";
const metaCalls: string[] = [];
const metaFetch = (async (url: string) => {
  metaCalls.push(url);
  const u = new URL(url);
  if (mode === "expired") return Response.json({ error: { message: "Session has expired", code: 190, fbtrace_id: "TR1" } }, { status: 400 });
  if (mode === "throttled") return Response.json({ error: { message: "User request limit reached", code: 17 } }, { status: 400 });
  if (u.pathname.endsWith("/me/adaccounts")) return Response.json({ data: [{ account_id: "123", name: "Main", currency: "SAR", timezone_name: "Asia/Riyadh" }] });
  const range = JSON.parse(u.searchParams.get("time_range")!) as { since: string; until: string };
  const data = [];
  for (let d = new Date(`${range.since}T00:00:00Z`); d <= new Date(`${range.until}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    data.push({ date_start: day, account_currency: "SAR", campaign_id: "c1", campaign_name: "Eid", adset_id: "s1", adset_name: "KSA", ad_id: "a1", ad_name: "Img", impressions: "100", clicks: "5", spend: "10.00" });
    data.push({ date_start: day, account_currency: "SAR", campaign_id: "c1", campaign_name: "Eid", adset_id: "s1", adset_name: "KSA", ad_id: "a2", ad_name: "Vid", impressions: "50", clicks: "1", spend: "2.50" });
  }
  return Response.json({ data });
}) as unknown as typeof fetch;
const http = { fetchImpl: metaFetch, baseDelayMs: 0, sleep: async () => {} };

beforeAll(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "b".repeat(64);
  A = await makeTenant("int");
  B = await makeTenant("int-b");
});

describe("ad connections", () => {
  it("stores credentials encrypted, out of the tenant role's reach, and reports what's missing", async () => {
    const r = await saveAdConnection(A.ctx, A.app.id, { environmentId: A.dev.id, provider: "meta_ads", secrets: { access_token: "EAAB-secret-token" }, settings: {} });
    expect(r.missing).toEqual(["Ad account IDs (comma-separated, digits)"]);
    const raw = await withSystem((db) => db.one<{ credentials_enc: string }>("select credentials_enc from platform.integration_connections where id = $1", [r.id]));
    expect(raw!.credentials_enc).not.toContain("EAAB-secret-token");
    await expect(withTenant({ organizationId: A.org.id, userId: A.user.id }, (db) => db.query("select credentials_enc from platform.integration_connections"))).rejects.toThrow(/permission denied/);

    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    expect(conn).toMatchObject({ provider: "meta_ads", has_credentials: true, missing_fields: ["Ad account IDs (comma-separated, digits)"] });
    // Capabilities exist but are off: saving credentials starts nothing.
    expect(conn.capabilities.map((c) => [c.capability, c.enabled, c.status])).toEqual([["ad_reporting", false, "not_configured"], ["spend_import", false, "not_configured"]]);

    // Settings added later; a blank secret keeps the stored one.
    await saveAdConnection(A.ctx, A.app.id, { environmentId: A.dev.id, provider: "meta_ads", secrets: { access_token: "" }, settings: { ad_account_ids: "123" } });
    await expect(saveAdConnection(A.ctx, A.app.id, { environmentId: A.dev.id, provider: "meta_ads", settings: { ad_account_ids: "abc" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveAdConnection(A.ctx, A.app.id, { environmentId: A.dev.id, provider: "myspace_ads" })).rejects.toBeInstanceOf(ValidationError);
    await setCapability(A.ctx, A.app.id, conn.id, "ad_reporting", { enabled: true });
    const [after] = await listConnections(A.ctx, A.app.id, A.dev.id);
    expect(after.missing_fields).toEqual([]);
    expect(after.capabilities.find((c) => c.capability === "ad_reporting")).toMatchObject({ enabled: true, status: "unverified" });
  });

  it("verifies against the (fake) provider and records auth failures on the capability", async () => {
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    mode = "expired";
    const bad = await verifyConnection(A.ctx, A.app.id, conn.id, { http });
    expect(bad.ok).toBe(false);
    expect((await listConnections(A.ctx, A.app.id, A.dev.id))[0].capabilities.find((c) => c.capability === "ad_reporting")).toMatchObject({ status: "error", last_error: expect.stringContaining("code 190") });
    mode = "ok";
    const good = await verifyConnection(A.ctx, A.app.id, conn.id, { http });
    expect(good).toEqual({ ok: true, accounts: [{ id: "123", name: "Main", currency: "SAR", timezone: "Asia/Riyadh" }] });
    expect((await listConnections(A.ctx, A.app.id, A.dev.id))[0].capabilities.find((c) => c.capability === "ad_reporting")!.status).toBe("verified");
    // The access token travels to the provider, never into stored errors.
    expect(metaCalls.some((u) => u.includes("access_token=EAAB-secret-token"))).toBe(true);
    const errors = await withSystem((db) => db.query<{ last_error: string | null }>("select last_error from platform.integration_capabilities"));
    expect(errors.some((e) => e.last_error?.includes("EAAB"))).toBe(false);
  });

  it("imports daily reporting, and cost into Ad spend without touching hand-entered days", async () => {
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    const scope = { appId: A.app.id, environmentId: A.dev.id, timezone: "Asia/Riyadh" };
    await saveSpend(A.ctx, scope, { date: "2026-10-05", source: "meta", campaign: "Eid", currency: "SAR", amount: "99" });

    const first = await syncConnection(conn.id, { http, today: TODAY });
    expect(first).toMatchObject({ ok: true, kind: "incremental", from: "2026-09-10", to: TODAY, rows: 60, spendRows: 0 });
    const perf = await withSystem((db) => db.one<{ n: string; spend: string }>("select count(*) as n, sum(spend)::text as spend from platform.ad_performance_daily where connection_id = $1", [conn.id]));
    expect(perf).toEqual({ n: "60", spend: "375.0000" });
    const entities = await withSystem((db) => db.query<{ level: string; external_id: string }>("select level, external_id from platform.ad_entities where connection_id = $1 order by level, external_id", [conn.id]));
    expect(entities.map((e) => `${e.level}:${e.external_id}`)).toEqual(["account:123", "ad:a1", "ad:a2", "adset:s1", "campaign:c1"]);

    // Cost import is its own capability; turning it on writes what is already imported.
    await expect(setCapability(A.ctx, A.app.id, conn.id, "spend_import", { enabled: true, spendSource: "bad source!" })).rejects.toBeInstanceOf(ValidationError);
    await setCapability(A.ctx, A.app.id, conn.id, "spend_import", { enabled: true });
    let spend = await listSpend(A.ctx, A.dev.id);
    expect(spend.filter((s) => s.origin === "import")).toHaveLength(29);
    expect(spend.find((s) => s.date === "2026-10-05")).toMatchObject({ origin: "manual", amount: 99 });
    expect(spend.find((s) => s.date === "2026-10-06")).toMatchObject({ origin: "import", source: "meta", campaign: "Eid", currency: "SAR", amount: 12.5 });

    // The next run re-imports the restatement window and reports the kept hand-entered day.
    const second = await syncConnection(conn.id, { http, today: TODAY });
    expect(second).toMatchObject({ ok: true, from: "2026-10-06", to: TODAY, spendRows: 4, spendSkipped: 0 });
    const runs = await withSystem((db) => db.query<{ status: string; rows_imported: number }>("select status, rows_imported from platform.integration_sync_runs where connection_id = $1 order by started_at", [conn.id]));
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);

    // Entering a day by hand replaces the imported amount; the import then leaves it alone.
    await saveSpend(A.ctx, scope, { date: "2026-10-07", source: "meta", campaign: "Eid", currency: "SAR", amount: "7" });
    const third = await syncConnection(conn.id, { http, today: TODAY });
    expect(third).toMatchObject({ spendRows: 3, spendSkipped: 1 });
    spend = await listSpend(A.ctx, A.dev.id);
    expect(spend.find((s) => s.date === "2026-10-07")).toMatchObject({ origin: "manual", amount: 7 });

    const [after] = await listConnections(A.ctx, A.app.id, A.dev.id);
    expect(after.capabilities.find((c) => c.capability === "spend_import")).toMatchObject({ status: "verified", data_fresh_through: TODAY });

    // Turning cost import off removes only imported rows.
    await setCapability(A.ctx, A.app.id, conn.id, "spend_import", { enabled: false });
    spend = await listSpend(A.ctx, A.dev.id);
    expect(spend.every((s) => s.origin === "manual")).toBe(true);
    expect(spend).toHaveLength(2);
    await setCapability(A.ctx, A.app.id, conn.id, "spend_import", { enabled: true });
  });

  it("retries throttling with backoff, and stops scheduling on auth errors until credentials change", async () => {
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    mode = "throttled";
    const r = await syncConnection(conn.id, { http: { ...http, maxAttempts: 2 }, today: TODAY });
    expect(r).toMatchObject({ ok: false, errorKind: "rate_limited" });
    let cap = await withSystem((db) => db.one<{ status: string; due_later: boolean; error_count: number }>(
      "select status, next_sync_at > now() + interval '10 minutes' as due_later, error_count from platform.integration_capabilities where connection_id = $1 and capability = 'ad_reporting'", [conn.id]));
    expect(cap).toEqual({ status: "error", due_later: true, error_count: 1 });

    mode = "expired";
    expect(await syncConnection(conn.id, { http, today: TODAY })).toMatchObject({ ok: false, errorKind: "auth" });
    cap = await withSystem((db) => db.one("select status, next_sync_at is null as due_later, error_count from platform.integration_capabilities where connection_id = $1 and capability = 'ad_reporting'", [conn.id]));
    expect(cap).toEqual({ status: "error", due_later: true, error_count: 2 });
    // Cost import shows the failure too, since it depends on reporting.
    const spendCap = (await listConnections(A.ctx, A.app.id, A.dev.id))[0].capabilities.find((c) => c.capability === "spend_import")!;
    expect(spendCap.status).toBe("error");

    // New credentials clear the error and schedule a run.
    mode = "ok";
    await saveAdConnection(A.ctx, A.app.id, { environmentId: A.dev.id, provider: "meta_ads", secrets: { access_token: "EAAB-new-token" } });
    const due = await withSystem((db) => db.one<{ due: boolean; error_count: number }>("select next_sync_at <= now() as due, error_count from platform.integration_capabilities where connection_id = $1 and capability = 'ad_reporting'", [conn.id]));
    expect(due).toEqual({ due: true, error_count: 0 });
    const jobs = await runAdSyncJobs({ http, today: TODAY });
    expect(jobs).toEqual({ synced: 1, failed: 0 });
  });

  it("backfills history in chunks down to the requested day", async () => {
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    await expect(requestBackfill(A.ctx, A.app.id, conn.id, "2020-01-01", "Asia/Riyadh")).rejects.toBeInstanceOf(ValidationError);
    await withSystem((db) => db.query("update platform.integration_capabilities set backfill_from = '2026-08-01', backfill_cursor = null where connection_id = $1 and capability = 'ad_reporting'", [conn.id]));
    const r1 = await syncConnection(conn.id, { http, today: TODAY });
    expect(r1).toMatchObject({ ok: true, kind: "backfill", from: "2026-08-11", to: "2026-09-09" });
    const r2 = await syncConnection(conn.id, { http, today: TODAY });
    expect(r2).toMatchObject({ kind: "backfill", from: "2026-08-01", to: "2026-08-10" });
    const cap = await withSystem((db) => db.one("select backfill_from, backfill_cursor from platform.integration_capabilities where connection_id = $1 and capability = 'ad_reporting'", [conn.id]));
    expect(cap).toEqual({ backfill_from: null, backfill_cursor: null });
    const min = await withSystem((db) => db.one<{ d: string }>("select min(day)::text as d from platform.ad_spend_daily where connection_id = $1", [conn.id]));
    expect(min!.d).toBe("2026-08-01");
  });

  it("enforces integrations.manage, and isolates organizations", async () => {
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    const analyst: TenantContext = { ...A.ctx, role: "analyst" };
    await expect(saveAdConnection(analyst, A.app.id, { environmentId: A.dev.id, provider: "tiktok_ads", secrets: { access_token: "x" } })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCapability(analyst, A.app.id, conn.id, "ad_reporting", { enabled: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(syncNow(analyst, A.app.id, conn.id, { http })).rejects.toBeInstanceOf(ForbiddenError);
    // Another organization can't see or touch it, even with the id.
    expect(await listConnections(B.ctx, B.app.id, B.dev.id)).toEqual([]);
    await expect(listConnections(B.ctx, A.app.id, A.dev.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(setCapability(B.ctx, B.app.id, conn.id, "ad_reporting", { enabled: false })).rejects.toBeInstanceOf(NotFoundError);
    await expect(verifyConnection(B.ctx, B.app.id, conn.id, { http })).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeConnection(B.ctx, B.app.id, conn.id)).rejects.toBeInstanceOf(NotFoundError);
    const rows = await withTenant({ organizationId: B.org.id, userId: B.user.id }, (db) => db.query("select 1 from platform.ad_performance_daily"));
    expect(rows).toEqual([]);
  });

  it("shows the center per capability, and removes a connection with its imported spend only", async () => {
    const data = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(data.connections[0].capabilities.map((c) => c.status)).toEqual(["verified", "verified"]);
    expect(data.postbacks).toEqual({});
    const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
    await removeConnection(A.ctx, A.app.id, conn.id);
    expect(await listConnections(A.ctx, A.app.id, A.dev.id)).toEqual([]);
    const spend = await listSpend(A.ctx, A.dev.id);
    expect(spend.map((s) => s.origin)).toEqual(["manual", "manual"]);
  });
});

describe("OAuth state", () => {
  const env = { META_APP_ID: "app", META_APP_SECRET: "secret" };
  it("is single-use, bound to the user and provider, and must match the cookie", async () => {
    Object.assign(process.env, env);
    try {
      const path = `/o/${A.org.slug}/apps/${A.app.slug}/settings/integrations/meta_ads`;
      await expect(startOAuth(A.ctx, A.app.id, A.dev.id, "meta_ads", "https://evil.example/")).rejects.toBeInstanceOf(ValidationError);
      const { state } = await startOAuth(A.ctx, A.app.id, A.dev.id, "meta_ads", path);
      expect(state).toMatchObject(expect.any(String));
      await expect(consumeOAuthState(A.user.id, "meta_ads", state, "other-cookie")).rejects.toThrow(/mismatched/);
      await expect(consumeOAuthState(B.user.id, "meta_ads", state, state)).rejects.toThrow(/another user/);
      // That attempt consumed it: a state works once.
      await expect(consumeOAuthState(A.user.id, "meta_ads", state, state)).rejects.toThrow(/already used/);

      const s2 = (await startOAuth(A.ctx, A.app.id, A.dev.id, "meta_ads", path)).state;
      await expect(consumeOAuthState(A.user.id, "google_ads", s2, s2)).rejects.toThrow(/provider/);
      const s3 = (await startOAuth(A.ctx, A.app.id, A.dev.id, "meta_ads", path)).state;
      await withSystem((db) => db.query("update platform.integration_oauth_states set expires_at = now() - interval '1 second' where consumed_at is null"));
      await expect(consumeOAuthState(A.user.id, "meta_ads", s3, s3)).rejects.toThrow(/expired/);

      const s4 = (await startOAuth(A.ctx, A.app.id, A.dev.id, "meta_ads", path)).state;
      const row = await consumeOAuthState(A.user.id, "meta_ads", s4, s4);
      expect(row).toMatchObject({ environment_id: A.dev.id, return_path: path });
      const fetchImpl = (async (url: string) => Response.json({ access_token: url.includes("fb_exchange_token") ? "long-lived" : "short" })) as unknown as typeof fetch;
      await completeOAuth(A.ctx, row, "meta_ads", "the-code", "https://app.example/integrations/oauth/meta_ads/callback", { http: { fetchImpl } });
      const [conn] = await listConnections(A.ctx, A.app.id, A.dev.id);
      // Connected through OAuth, but still unverified: no reporting call has succeeded.
      expect(conn).toMatchObject({ provider: "meta_ads", auth_method: "oauth", granted_scopes: ["ads_read"], missing_fields: ["Ad account IDs (comma-separated, digits)"] });
      await removeConnection(A.ctx, A.app.id, conn.id);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });
});

describe("outbound conversions: eligibility and provider errors", () => {
  async function send(events: Record<string, unknown>[]) {
    const sdk = (await authenticateIngestionKey(A.sdkKey))!;
    await ingest(sdk, { batch: events }, { mode: "batch" });
    await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
  }
  const ev = (name: string, anon: string, o: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), anonymous_id: anon, ...o });
  const ua = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  let ip = 0;
  async function clickOn(code: string, query: Record<string, string>): Promise<string> {
    const out = await handleClick(code, { method: "GET", headers: new Headers({ "user-agent": ua }), ip: `198.51.100.${++ip}`, query: new URLSearchParams(query) });
    if (out.status !== 302 || !out.recorded) throw new Error("click not recorded");
    return out.clickId;
  }

  it("skips denied consent and unmatched events, and records provider codes on failures", async () => {
    const link = await createLink(A.ctx, A.app.id, { environmentId: A.dev.id, name: "FB", source: "facebook", webUrl: "https://example.com" });
    const snapLink = await createLink(A.ctx, A.app.id, { environmentId: A.dev.id, name: "Snap", source: "snapchat", webUrl: "https://example.com" });
    const meta = await createPostback(A.ctx, A.app.id, { environmentId: A.dev.id, network: "meta", name: "Meta CAPI", events: "install", config: { dataset_id: "555" }, credentials: { access_token: "META-TOKEN" } });
    const snap = await createPostback(A.ctx, A.app.id, { environmentId: A.dev.id, network: "snapchat", name: "Snap CAPI", events: "install", sources: "snapchat", config: { snap_app_id: "snap-app" }, credentials: { access_token: "SNAP-TOKEN" } });

    const c1 = await clickOn(link.code, { fbclid: "FB.one" });
    const c2 = await clickOn(link.code, { fbclid: "FB.two" });
    const c3 = await clickOn(snapLink.code, {});
    await send([ev("app_installed", "conv-ok", { context: { platform: "android", attribution: { click_id: c1 } } })]);
    await send([ev("app_installed", "conv-denied", { context: { platform: "android", attribution: { click_id: c2 } } })]);
    await send([ev("app_installed", "conv-snap", { context: { platform: "android", attribution: { click_id: c3 } } })]);
    // Consent withdrawn after the delivery was queued: checked again at send time.
    await send([{ type: "consent", anonymous_id: "conv-denied", consent: { attribution: false } }]);

    const sent: { url: string; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      return Response.json({ error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 2804050, fbtrace_id: "TRACE-9" } }, { status: 400 });
    }) as unknown as typeof fetch;
    expect(await deliverPostbacks({ fetchImpl: fake })).toEqual({ succeeded: 0, retrying: 0, failed: 1, skipped: 2 });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).data[0]).toMatchObject({ event_name: "MobileAppInstall", user_data: { fbc: expect.stringContaining("FB.one"), anon_id: "conv-ok" } });

    const rows = await withSystem((db) => db.query<{ postback_id: string; status: string; skip_reason: string | null; provider_error_code: string | null; provider_trace_id: string | null; request_summary: Record<string, unknown> | null }>(
      "select postback_id, status, skip_reason, provider_error_code, provider_trace_id, request_summary from platform.attribution_postback_deliveries where postback_id = any($1) order by status", [[meta.id, snap.id]]));
    expect(rows).toEqual([
      expect.objectContaining({ postback_id: meta.id, status: "failed", provider_error_code: "100/2804050", provider_trace_id: "TRACE-9", request_summary: expect.objectContaining({ endpoint: "graph.facebook.com/v21.0/555/events" }) }),
      expect.objectContaining({ status: "skipped", skip_reason: expect.stringMatching(/consent_denied|no_match_key/) }),
      expect.objectContaining({ status: "skipped", skip_reason: expect.stringMatching(/consent_denied|no_match_key/) }),
    ]);
    expect(new Set(rows.filter((r) => r.status === "skipped").map((r) => r.skip_reason))).toEqual(new Set(["consent_denied", "no_match_key"]));
    expect(JSON.stringify(rows)).not.toContain("META-TOKEN");

    const center = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(center.postbacks!.meta).toMatchObject({ withCredentials: 1, skipped: 1, recentErrors: [expect.objectContaining({ code: "100/2804050" })] });
  });
});
