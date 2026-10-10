/**
 * Attribution engine against Postgres: tracking-link redirects and click
 * recording (bots, prefetches, rate limits), deterministic and probabilistic
 * install matching, lookback windows, organic, reinstalls, re-engagement,
 * conversions, postback delivery with retries against a local HTTP server,
 * permissions and tenant isolation.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { deliverPostbacks, purgeClickFingerprints } from "@/modules/attribution/delivery";
import { processAdServicesLookups, queueAdServicesTokens } from "@/modules/attribution/adservices";
import { applyAdServicesAttribution } from "@/modules/attribution/engine";
import { attributionOverview } from "@/modules/attribution/reports";
import { channelReport } from "@/modules/channels/report";
import { tenantTx } from "@/modules/tenancy/context";
import {
  CLICKS_PER_IP_PER_MINUTE, createLink, createPostback, getSettings, handleClick, listLinks, listPostbacks, setLinkStatus, setPostbackStatus, updateSettings, type LinkRow,
} from "@/modules/attribution/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let link: LinkRow;

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;

function click(code: string, o: { ua?: string; ip?: string; query?: Record<string, string>; method?: string; headers?: Record<string, string> } = {}) {
  return handleClick(code, {
    method: o.method ?? "GET",
    headers: new Headers({ "user-agent": o.ua ?? ANDROID, "x-vercel-ip-country": "SA", ...o.headers }),
    ip: o.ip ?? nextIp(),
    query: new URLSearchParams(o.query ?? {}),
  });
}

async function recorded(code: string, o: Parameters<typeof click>[1] = {}) {
  const out = await click(code, o);
  if (out.status !== 302 || !out.recorded) throw new Error(`click not recorded: ${JSON.stringify(out)}`);
  return out;
}

async function send(events: Record<string, unknown>[], opts: { clientIp?: string; key?: string } = {}) {
  const sdk = (await authenticateIngestionKey(opts.key ?? t.sdkKey))!;
  const res = await ingest(sdk, { batch: events }, { mode: "batch", clientIp: opts.clientIp });
  expect((res.body as { accepted: number }).accepted).toBe(events.length);
  await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
}

const ev = (name: string, anon: string, o: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), anonymous_id: anon, ...o });

async function attributionOf(anon: string, kind = "install") {
  return withSystem((db) =>
    db.one<{ id: string; kind: string; match_type: string; match_key: string | null; source: string | null; campaign: string | null; link_id: string | null; network: string | null; touchpoint_id: string | null }>(
      "select id, kind, match_type, match_key, source, campaign, link_id, network, touchpoint_id from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind = $3",
      [t.dev.id, anon, kind],
    ),
  );
}

// ── Local postback receiver ─────────────────────────────────────────────────
let server: Server;
let base = "";
const received: { url: string; method: string; body: string }[] = [];
const replies: number[] = []; // status codes to answer with, in order (then 200)

beforeAll(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "a".repeat(64);
  t = await makeTenant("attr");
  other = await makeTenant("attr-other");
  link = await createLink(t.ctx, t.app.id, {
    environmentId: t.dev.id, name: "Ramadan TikTok", source: "tiktok", medium: "paid_social", campaign: "ramadan",
    iosUrl: "https://apps.apple.com/app/id123", androidUrl: "https://play.google.com/store/apps/details?id=com.example", webUrl: "https://example.com/app",
    deepLinkPath: "/offers/ramadan",
  });
  server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ url: req.url ?? "", method: req.method ?? "", body });
      res.statusCode = replies.shift() ?? 200;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe("tracking links", () => {
  it("validates links", async () => {
    await expect(createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "x", source: "google" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "x", source: "google", webUrl: "http://example.com" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "x", source: "google", webUrl: "https://e.com", deepLinkPath: "javascript:alert(1)" })).rejects.toBeInstanceOf(ValidationError);
    expect(link.code).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("redirects each platform and records the click without the raw IP", async () => {
    const ip = "198.51.100.77";
    const out = await recorded(link.code, { ip, query: { ttclid: "E.C.P.tt1", utm_content: "video_7" } });
    const dest = new URL(out.location);
    expect(dest.host).toBe("play.google.com");
    const ref = new URLSearchParams(dest.searchParams.get("referrer")!);
    expect(ref.get("click_id")).toBe(out.clickId);
    expect(ref.get("utm_content")).toBe("video_7");

    const row = await withSystem((db) => db.one("select * from platform.attribution_touchpoints where click_id = $1", [out.clickId]));
    expect(row).toMatchObject({ kind: "click", link_id: link.id, source: "tiktok", campaign: "ramadan", creative: "video_7", os_name: "android", os_major: "14", country: "SA", network_click_id: "E.C.P.tt1", network: "tiktok" });
    expect(row!.ip_hash).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(row)).not.toContain(ip);

    const ios = await recorded(link.code, { ua: IPHONE });
    expect(ios.location).toBe("https://apps.apple.com/app/id123");
    const web = await recorded(link.code, { ua: DESKTOP });
    expect(new URL(web.location).searchParams.get("click_id")).toBe(web.clickId);
    expect((await click("nope_nope")).status).toBe(404);
  });

  it("redirects bots, link previews, prefetches and HEAD without recording them", async () => {
    const count = async () => Number((await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.attribution_touchpoints where link_id = $1", [link.id])))!.n);
    const before = await count();
    const outs = await Promise.all([
      click(link.code, { ua: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" }),
      click(link.code, { ua: "WhatsApp/2.23.20.0 A" }),
      click(link.code, { ua: "curl/8.4.0" }),
      click(link.code, { headers: { "sec-purpose": "prefetch" } }),
      click(link.code, { method: "HEAD" }),
    ]);
    expect(outs.map((o) => o.status === 302 && !o.recorded && o.reason)).toEqual(["bot", "bot", "bot", "prefetch", "head"]);
    expect(await count()).toBe(before);
  });

  it("rate-limits one sender but still redirects", async () => {
    const ip = nextIp();
    const outs = [];
    for (let i = 0; i <= CLICKS_PER_IP_PER_MINUTE; i++) outs.push(await click(link.code, { ip }));
    expect(outs.filter((o) => o.status === 302 && o.recorded).length).toBe(CLICKS_PER_IP_PER_MINUTE);
    const last = outs.at(-1)!;
    expect(last.status === 302 && !last.recorded && last.reason).toBe("rate_limited");
    expect(last.status === 302 && last.location).toMatch(/^https:\/\/play\.google\.com\//);
  });

  it("stops recording paused links", async () => {
    const paused = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "Paused", source: "snapchat", webUrl: "https://example.com" });
    await setLinkStatus(t.ctx, t.app.id, paused.id, "paused");
    const out = await click(paused.code);
    expect(out.status === 302 && !out.recorded && out.reason).toBe("paused");
  });
});

describe("install attribution", () => {
  it("matches the Play install referrer deterministically", async () => {
    const c = await recorded(link.code);
    const referrer = new URL(c.location).searchParams.get("referrer")!;
    await send([ev("app_installed", "inst-ref", { context: { platform: "android", campaign: { install_referrer: referrer, referrer_click_timestamp_seconds: Math.floor(Date.now() / 1000) } } })]);
    expect(await attributionOf("inst-ref")).toMatchObject({ match_type: "deterministic", match_key: "install_referrer", source: "tiktok", campaign: "ramadan", link_id: link.id, network: "tiktok" });
    const tp = await withSystem((db) => db.one<{ matched_at: Date | null; anonymous_id: string }>("select matched_at, anonymous_id from platform.attribution_touchpoints where click_id = $1", [c.clickId]));
    expect(tp?.matched_at).not.toBeNull();
    expect(tp?.anonymous_id).toBe("inst-ref");
  });

  it("matches a click id the SDK passes in context, and a deep link", async () => {
    const a = await recorded(link.code, { ua: IPHONE });
    await send([ev("app_installed", "inst-ctx", { context: { platform: "ios", attribution: { click_id: a.clickId } } })]);
    expect(await attributionOf("inst-ctx")).toMatchObject({ match_type: "deterministic", match_key: "click_id", link_id: link.id });
    const b = await recorded(link.code, { ua: IPHONE });
    await send([ev("app_installed", "inst-dl", { context: { platform: "ios", attribution: { deep_link_url: `myapp://offers?click_id=${b.clickId}` } } })]);
    expect(await attributionOf("inst-dl")).toMatchObject({ match_type: "deterministic", match_key: "deep_link" });
  });

  it("matches ad-network click ids: deterministic when our link recorded them, reported when only the install carries one", async () => {
    await recorded(link.code, { query: { ttclid: "E.C.P.only-on-click" } });
    await send([ev("app_installed", "inst-ttclid", { context: { platform: "android", attribution: { ttclid: "E.C.P.only-on-click" } } })]);
    expect(await attributionOf("inst-ttclid")).toMatchObject({ match_type: "deterministic", match_key: "ttclid", link_id: link.id });

    // Was "deterministic" before 0030: no click of ours carries this gclid, only the install's context says so.
    await send([ev("app_installed", "inst-gclid", { context: { platform: "android", attribution: { gclid: "Cj0K-xyz", utm_campaign: "search_brand" } } })]);
    expect(await attributionOf("inst-gclid")).toMatchObject({ match_type: "reported", match_key: "gclid", source: "google", network: "google", campaign: "search_brand", link_id: null });
  });

  it("labels UTM-only installs reported, never deterministic", async () => {
    await send([ev("app_installed", "inst-utm", { context: { platform: "android", attribution: { utm_source: "snapchat", utm_campaign: "eid", deep_link_url: "myapp://offers?utm_source=snapchat" } } })]);
    expect(await attributionOf("inst-utm")).toMatchObject({ match_type: "reported", match_key: "utm_parameters", source: "snapchat", campaign: "eid", link_id: null });
    // A Play referrer with campaign parameters but no LeanApp click id: still only reported.
    await send([ev("app_installed", "inst-utm-ref", { context: { platform: "android", campaign: { install_referrer: "utm_source=tiktok&utm_campaign=summer", referrer_click_timestamp_seconds: Math.floor(Date.now() / 1000) } } })]);
    expect(await attributionOf("inst-utm-ref")).toMatchObject({ match_type: "reported", match_key: "install_referrer", source: "tiktok" });
    // The same referrer carrying a LeanApp click id of a recorded click is deterministic.
    const c = await recorded(link.code);
    await send([ev("app_installed", "inst-utm-click", { context: { platform: "android", campaign: { install_referrer: `click_id=${c.clickId}&utm_source=tiktok&utm_campaign=summer` } } })]);
    expect(await attributionOf("inst-utm-click")).toMatchObject({ match_type: "deterministic", match_key: "install_referrer", link_id: link.id });
  });

  it("shows paid iOS installs without a LeanApp click id as organic, never matched by guesswork", async () => {
    const ip = "198.51.100.150";
    await recorded(link.code, { ua: IPHONE, ip });
    await send([ev("app_installed", "inst-ios-paid", { context: { platform: "ios", os_version: "17.4" } })], { clientIp: ip });
    expect(await attributionOf("inst-ios-paid")).toMatchObject({ match_type: "organic", touchpoint_id: null });
  });

  it("marks installs with nothing to match as organic", async () => {
    await send([ev("app_installed", "inst-organic", { context: { platform: "android" } })]);
    expect(await attributionOf("inst-organic")).toMatchObject({ match_type: "organic", source: null, touchpoint_id: null });
  });

  it("respects the click lookback window", async () => {
    const c = await recorded(link.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '10 days' where click_id = $1", [c.clickId]));
    await send([ev("app_installed", "inst-old", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    expect(await attributionOf("inst-old")).toMatchObject({ match_type: "organic" });

    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 14, probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" });
    await send([ev("app_installed", "inst-old-2", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    expect(await attributionOf("inst-old-2")).toMatchObject({ match_type: "deterministic" });

    // A Play referrer reporting a store click older than the window is organic too.
    await send([ev("app_installed", "inst-old-ref", { context: { platform: "android", campaign: { install_referrer: "utm_source=snapchat", referrer_click_timestamp_seconds: Math.floor(Date.now() / 1000) - 30 * 86400 } } })]);
    expect(await attributionOf("inst-old-ref")).toMatchObject({ match_type: "organic" });
  });

  it("uses probabilistic matching only when enabled, only on Android, labelled as such", async () => {
    const ip = "198.51.100.200";
    await recorded(link.code, { ip });
    await send([ev("app_installed", "inst-prob-off", { context: { platform: "android", os_version: "14" } })], { clientIp: ip });
    expect(await attributionOf("inst-prob-off")).toMatchObject({ match_type: "organic" });

    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticEnabled: "on", probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" });
    await send([ev("app_installed", "inst-ios", { context: { platform: "ios", os_version: "17.4" } })], { clientIp: ip });
    expect(await attributionOf("inst-ios")).toMatchObject({ match_type: "organic" });
    await send([ev("app_installed", "inst-prob", { context: { platform: "android", os_version: "14" } })], { clientIp: ip });
    expect(await attributionOf("inst-prob")).toMatchObject({ match_type: "probabilistic", match_key: "ip_ua", link_id: link.id });
    // The click is now claimed: a second install from the same address doesn't reuse it.
    await send([ev("app_installed", "inst-prob-2", { context: { platform: "android", os_version: "14" } })], { clientIp: ip });
    expect(await attributionOf("inst-prob-2")).toMatchObject({ match_type: "organic" });

    // Clients can't plant their own IP hash.
    const stored = await withSystem((db) => db.one<{ context: Record<string, unknown> }>("select context from platform.events where environment_id = $1 and anonymous_id = 'inst-prob'", [t.dev.id]));
    expect((stored!.context._server as { ip_hash: string }).ip_hash).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await send([ev("app_installed", "inst-forged", { context: { platform: "android", _server: { ip_hash: "forged" } } })]);
    const forged = await withSystem((db) => db.one<{ context: Record<string, unknown> }>("select context from platform.events where environment_id = $1 and anonymous_id = 'inst-forged'", [t.dev.id]));
    expect(forged!.context._server).toBeUndefined();
    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" });
  });

  it("records reinstalls and ignores repeated installs", async () => {
    await send([ev("app_installed", "dev-1-a", { context: { platform: "android", device: { id: "device-1" } } })]);
    await send([ev("app_installed", "dev-1-a", { context: { platform: "android", device: { id: "device-1" } } })]);
    await send([ev("app_installed", "dev-1-b", { context: { platform: "android", device: { id: "device-1" } } })]);
    const rows = await withSystem((db) => db.query<{ anonymous_id: string; kind: string }>("select anonymous_id, kind from platform.attribution_events where environment_id = $1 and device_id = 'device-1' order by occurred_at", [t.dev.id]));
    expect(rows).toEqual([{ anonymous_id: "dev-1-a", kind: "install" }, { anonymous_id: "dev-1-b", kind: "reinstall" }]);
  });

  it("credits a newer link click on app open as re-engagement, once", async () => {
    const other = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "Snap retarget", source: "snapchat", campaign: "winback", androidUrl: "https://play.google.com/store/apps/details?id=com.example" });
    const c = await recorded(other.code);
    const open = () => ev("app_opened", "inst-ref", { context: { platform: "android", attribution: { click_id: c.clickId } } });
    await send([open(), open()]);
    const rows = await withSystem((db) => db.query<{ source: string; campaign: string }>("select source, campaign from platform.attribution_events where environment_id = $1 and anonymous_id = 'inst-ref' and kind = 're_engagement'", [t.dev.id]));
    expect(rows).toEqual([{ source: "snapchat", campaign: "winback" }]);
  });
});

describe("conversions", () => {
  it("attributes revenue to the last touch, by install or by identified user", async () => {
    // inst-ref re-engaged through snapchat → last touch is snapchat.
    await send([ev("purchase_completed", "inst-ref", { properties: { transaction_id: "t1", revenue: 549, currency: "SAR" } })]);
    // inst-ctx (tiktok link) identifies as u-ctx; the backend later sends a purchase with only the user id.
    await send([{ type: "identify", event_id: crypto.randomUUID(), anonymous_id: "inst-ctx", user_id: "u-ctx" }]);
    await send([{ type: "track", event_name: "purchase_completed", event_id: crypto.randomUUID(), user_id: "u-ctx", properties: { transaction_id: "t2", revenue: 100, currency: "SAR" } }]);
    // Not a conversion: no row.
    await send([ev("screen_thing_viewed", "inst-ref")]);
    const rows = await withSystem((db) =>
      db.query<{ event_name: string; revenue: string; currency: string; source: string; kind: string }>(
        `select c.event_name, c.revenue::text, c.currency, ae.source, ae.kind from platform.attribution_conversions c
           join platform.attribution_events ae on ae.id = c.attribution_event_id where c.environment_id = $1 order by c.revenue desc`,
        [t.dev.id],
      ),
    );
    expect(rows).toEqual([
      { event_name: "purchase_completed", revenue: "549", currency: "SAR", source: "snapchat", kind: "re_engagement" },
      { event_name: "purchase_completed", revenue: "100", currency: "SAR", source: "tiktok", kind: "install" },
    ]);
  });
});

describe("postbacks", () => {
  it("delivers custom URL postbacks with macros, retries 5xx with backoff and fails 4xx", async () => {
    const pb = await createPostback(t.ctx, t.app.id, {
      environmentId: t.dev.id, network: "custom", name: "Our BI",
      events: "install, purchase_completed",
      urlTemplate: `${base}/pb?click={click_id}&event={event}&rev={revenue}&cur={currency}&ts={timestamp}&src={source}`,
    });
    await expect(createPostback(t.ctx, t.app.id, { environmentId: t.dev.id, network: "custom", name: "bad", events: "install", urlTemplate: `${base}/?x={secret}` })).rejects.toBeInstanceOf(ValidationError);

    const c = await recorded(link.code);
    await send([ev("app_installed", "pb-install", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    await send([ev("purchase_completed", "pb-install", { properties: { transaction_id: "t3", revenue: 25.5, currency: "AED" } })]);
    await send([ev("app_installed", "pb-organic", { context: { platform: "android" } })]); // organic: not sent

    replies.push(503);
    received.length = 0;
    let r = await deliverPostbacks();
    expect(r).toEqual({ succeeded: 1, retrying: 1, failed: 0, skipped: 0 });
    const retry = await withSystem((db) => db.one<{ attempts: number; status: string; last_status_code: number; due: boolean }>(
      "select attempts, status, last_status_code, next_attempt_at > now() + interval '50 seconds' as due from platform.attribution_postback_deliveries where postback_id = $1 and status = 'pending'", [pb.id]));
    expect(retry).toMatchObject({ attempts: 1, status: "pending", last_status_code: 503, due: true });
    expect(await deliverPostbacks()).toEqual({ succeeded: 0, retrying: 0, failed: 0, skipped: 0 }); // not due yet
    await withSystem((db) => db.query("update platform.attribution_postback_deliveries set next_attempt_at = now() where postback_id = $1 and status = 'pending'", [pb.id]));
    r = await deliverPostbacks();
    expect(r).toEqual({ succeeded: 1, retrying: 0, failed: 0, skipped: 0 });

    const urls = received.map((x) => new URL(x.url, base));
    const install = urls.find((u) => u.searchParams.get("event") === "install")!;
    expect(install.searchParams.get("click")).toBe(c.clickId);
    expect(install.searchParams.get("src")).toBe("tiktok");
    const purchase = urls.find((u) => u.searchParams.get("event") === "purchase_completed")!;
    expect(purchase.searchParams.get("rev")).toBe("25.5");
    expect(purchase.searchParams.get("cur")).toBe("AED");
    expect(Number(purchase.searchParams.get("ts"))).toBeGreaterThan(1_700_000_000);
    expect(urls.some((u) => u.searchParams.get("event") === "install" && !u.searchParams.get("click"))).toBe(false);

    // A 400 is permanent.
    const c2 = await recorded(link.code);
    await send([ev("app_installed", "pb-400", { context: { platform: "android", attribution: { click_id: c2.clickId } } })]);
    replies.push(400);
    expect(await deliverPostbacks()).toEqual({ succeeded: 0, retrying: 0, failed: 1, skipped: 0 });
    const { postbacks, deliveries } = await listPostbacks(t.ctx, t.app.id, t.dev.id);
    expect(postbacks.find((p) => p.id === pb.id)).toMatchObject({ succeeded: 2, failed: 1, pending: 0 });
    expect(deliveries[0]).toMatchObject({ status: "failed", last_status_code: 400 });
    await setPostbackStatus(t.ctx, t.app.id, pb.id, "paused");
  });

  it("gives up after the last retry", async () => {
    const pb = await createPostback(t.ctx, t.app.id, { environmentId: t.dev.id, network: "custom", name: "Flaky", events: "install", urlTemplate: `${base}/flaky?c={click_id}` });
    const c = await recorded(link.code);
    await send([ev("app_installed", "pb-flaky", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      replies.push(500);
      await deliverPostbacks();
      const row = await withSystem((db) => db.one<{ status: string }>("update platform.attribution_postback_deliveries set next_attempt_at = now() where postback_id = $1 returning status", [pb.id]));
      statuses.push(row!.status);
    }
    expect(statuses).toEqual(["pending", "pending", "pending", "pending", "pending", "giving_up"]);
    await setPostbackStatus(t.ctx, t.app.id, pb.id, "deleted");
  });

  it("sends ad-network postbacks only for their own installs, with encrypted credentials", async () => {
    const pb = await createPostback(t.ctx, t.app.id, {
      environmentId: t.dev.id, network: "tiktok", name: "TikTok", events: "install",
      config: { tiktok_app_id: "7000001" }, credentials: { access_token: "tt-secret-token" },
    });
    expect(pb.has_credentials).toBe(true);
    const enc = await withSystem((db) => db.one<{ credentials_enc: string }>("select credentials_enc from platform.attribution_postbacks where id = $1", [pb.id]));
    expect(enc!.credentials_enc).not.toContain("tt-secret-token");
    await expect(createPostback(t.ctx, t.app.id, { environmentId: t.dev.id, network: "tiktok", name: "x", events: "install", config: { tiktok_app_id: "1" } })).rejects.toBeInstanceOf(ValidationError);

    const tt = await recorded(link.code, { query: { ttclid: "E.C.P.pb" } });
    await send([ev("app_installed", "pb-tt", { context: { platform: "android", attribution: { click_id: tt.clickId } } })]);
    await send([ev("app_installed", "pb-google", { context: { platform: "android", attribution: { gclid: "Cj0-pb" } } })]);
    const queued = await withSystem((db) => db.query<{ payload: { network_click_id: string } }>("select payload from platform.attribution_postback_deliveries where postback_id = $1", [pb.id]));
    expect(queued.map((q) => q.payload.network_click_id)).toEqual(["E.C.P.pb"]);

    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"code":0}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await deliverPostbacks({ fetchImpl: fake })).toEqual({ succeeded: 1, retrying: 0, failed: 0, skipped: 0 });
    expect(calls[0].url).toBe("https://business-api.tiktok.com/open_api/v1.3/event/track/");
    expect((calls[0].init.headers as Record<string, string>)["Access-Token"]).toBe("tt-secret-token");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ event_source: "app", event_source_id: "7000001", data: [{ event: "InstallApp", user: { ttclid: "E.C.P.pb" } }] });
    await setPostbackStatus(t.ctx, t.app.id, pb.id, "deleted");
  });

  it("refuses to store credentials without an encryption key", async () => {
    const key = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    try {
      await expect(createPostback(t.ctx, t.app.id, { environmentId: t.dev.id, network: "snapchat", name: "Snap", events: "install", config: { snap_app_id: "s" }, credentials: { access_token: "x" } }))
        .rejects.toThrow(/INTEGRATIONS_ENCRYPTION_KEY/);
    } finally {
      process.env.INTEGRATIONS_ENCRYPTION_KEY = key;
    }
  });
});

describe("reports, permissions and isolation", () => {
  it("reports installs, conversions and link rates per environment", async () => {
    const r = await attributionOverview(t.ctx, { environmentId: t.dev.id, timezone: "UTC" }, { days: 30 });
    expect(r.totals.installs).toBeGreaterThan(5);
    expect(r.totals.organic).toBeGreaterThan(0);
    expect(r.totals.probabilistic).toBe(1);
    expect(r.totals.reengagements).toBe(1);
    expect(r.totals.reported).toBeGreaterThanOrEqual(3); // inst-gclid, inst-utm, inst-utm-ref (+ pb-google)
    expect(r.totals.deterministic + r.totals.reported + r.totals.probabilistic).toBe(r.totals.attributed);
    expect(r.totals.organic_ios).toBeGreaterThanOrEqual(2); // inst-ios, inst-ios-paid
    expect(r.bySource.find((s) => s.source === "snapchat" && s.campaign === "eid")).toMatchObject({ installs: 1, deterministic: 0, reported: 1 });
    expect(r.bySource.find((s) => s.source === "tiktok" && s.campaign === "ramadan")!.installs).toBeGreaterThan(0);
    expect(r.byCampaign.find((c) => c.source === "snapchat")).toMatchObject({ revenue: 549, currency: "SAR" });
    const l = r.links.find((x) => x.id === link.id)!;
    expect(l.clicks).toBeGreaterThan(l.installs);
    expect(l.rate).toBeGreaterThan(0);
    const prod = await attributionOverview(t.ctx, { environmentId: t.environments.find((e) => e.type === "production")!.id, timezone: "UTC" }, { days: 30 });
    expect(prod.totals).toMatchObject({ clicks: 0, installs: 0, conversions: 0 });
    expect((await listLinks(t.ctx, t.app.id, t.dev.id)).find((x) => x.id === link.id)!.clicks).toBeGreaterThan(5);
  });

  it("enforces attribution.read / attribution.manage", async () => {
    const analyst: TenantContext = { ...t.ctx, role: "analyst" };
    const developer: TenantContext = { ...t.ctx, role: "developer" };
    expect((await listLinks(analyst, t.app.id, t.dev.id)).length).toBeGreaterThan(0);
    await expect(createLink(analyst, t.app.id, { environmentId: t.dev.id, name: "x", source: "x", webUrl: "https://e.com" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLinks(developer, t.app.id, t.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    const marketer: TenantContext = { ...t.ctx, role: "marketer" };
    expect((await createLink(marketer, t.app.id, { environmentId: t.dev.id, name: "m", source: "x", webUrl: "https://e.com" })).code).toBeTruthy();
  });

  it("keeps tenants apart", async () => {
    expect(await listLinks(other.ctx, t.app.id, t.dev.id)).toEqual([]);
    await expect(setLinkStatus(other.ctx, t.app.id, link.id, "paused")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createLink(other.ctx, t.app.id, { environmentId: t.dev.id, name: "x", source: "x", webUrl: "https://e.com" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listPostbacks(other.ctx, t.app.id, t.dev.id)).deliveries).toEqual([]);
    const r = await attributionOverview(other.ctx, { environmentId: t.dev.id, timezone: "UTC" }, { days: 30 });
    expect(r.totals).toMatchObject({ clicks: 0, installs: 0, conversions: 0 });
    expect(r.links).toEqual([]);
    // Another tenant's install carrying this tenant's click id never matches it.
    const c = await recorded(link.code);
    const sdk = (await authenticateIngestionKey(other.sdkKey))!;
    await ingest(sdk, { batch: [ev("app_installed", "x-tenant", { context: { platform: "android", attribution: { click_id: c.clickId } } })] }, { mode: "batch" });
    await processPendingEvents({ environmentId: other.dev.id });
    const row = await withSystem((db) => db.one<{ match_type: string }>("select match_type from platform.attribution_events where environment_id = $1 and anonymous_id = 'x-tenant'", [other.dev.id]));
    expect(row?.match_type).toBe("organic");
  });

  it("clears click fingerprints after a week", async () => {
    const c = await recorded(link.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '8 days' where click_id = $1", [c.clickId]));
    expect(await purgeClickFingerprints()).toBeGreaterThanOrEqual(1);
    const row = await withSystem((db) => db.one("select ip_hash, user_agent from platform.attribution_touchpoints where click_id = $1", [c.clickId]));
    expect(row).toEqual({ ip_hash: null, user_agent: null });
  });
});

// ── Attribution engine (0039): web touches, credit models, windows, evidence ─
describe("attribution engine", () => {
  let w: T;
  let wLink: LinkRow;
  const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  const webEv = (name: string, anon: string, attribution: Record<string, string> | null, o: Record<string, unknown> = {}) =>
    ev(name, anon, { context: { platform: "web", ...(attribution ? { attribution } : {}) }, ...o });
  const sendW = (events: Record<string, unknown>[]) => send(events, { key: w.sdkKey });

  async function touches(anon: string) {
    return withSystem((db) =>
      db.query<{ id: string; kind: string; source: string | null; match_type: string; match_key: string | null; method: string; confidence: string; evidence: Record<string, unknown>; referrer_host: string | null }>(
        `select id, kind, source, match_type, match_key, method, confidence, evidence, referrer_host from platform.attribution_events
          where environment_id = $1 and anonymous_id = $2 order by occurred_at, id`,
        [w.dev.id, anon],
      ),
    );
  }
  async function conversionOf(anon: string, name = "purchase_completed") {
    return withSystem((db) =>
      db.one<{ id: string; attribution_event_id: string | null; first_attribution_event_id: string | null; last_non_direct_attribution_event_id: string | null; credit_evidence: Record<string, unknown> }>(
        `select c.id, c.attribution_event_id, c.first_attribution_event_id, c.last_non_direct_attribution_event_id, c.credit_evidence
           from platform.attribution_conversions c join platform.events e on e.id = c.event_row_id
          where c.environment_id = $1 and e.anonymous_id = $2 and c.event_name = $3`,
        [w.dev.id, anon, name],
      ),
    );
  }
  const report = (model: string, ctx = w.ctx) =>
    channelReport(ctx, { appId: w.app.id, environmentId: w.dev.id, timezone: "UTC", includeSpend: false }, { days: 30, model });

  beforeAll(async () => {
    w = await makeTenant("attr-engine");
    wLink = await createLink(w.ctx, w.app.id, {
      environmentId: w.dev.id, name: "Meta prospecting", source: "facebook", medium: "paid_social", campaign: "launch",
      androidUrl: "https://play.google.com/store/apps/details?id=com.example", webUrl: "https://example.com/launch",
    });
  });

  it("credits web sign-ups and purchases to the web touch without an install", async () => {
    await sendW([
      webEv("page_viewed", "web-1", { utm_source: "newsletter", utm_medium: "email", utm_campaign: "june", landing_url: "https://example.com/?utm_source=newsletter&token=secret-123", referrer: "https://mail.example.org/" }, { timestamp: minutes(30) }),
      webEv("signup_completed", "web-1", null, { timestamp: minutes(20) }),
      webEv("purchase_completed", "web-1", null, { timestamp: minutes(10), properties: { transaction_id: "w1", revenue: 120, currency: "SAR" } }),
    ]);
    const [touch] = await touches("web-1");
    expect(touch).toMatchObject({ kind: "web_touch", source: "newsletter", match_type: "reported", match_key: "utm_parameters", method: "utm_parameters", confidence: "medium" });
    const tp = await withSystem((db) => db.one<{ kind: string; landing_page: string; referrer: string }>(
      "select t.kind, t.landing_page, t.referrer from platform.attribution_touchpoints t join platform.attribution_events ae on ae.touchpoint_id = t.id where ae.id = $1", [touch.id]));
    expect(tp).toEqual({ kind: "web", landing_page: "https://example.com/", referrer: "mail.example.org" });
    expect(JSON.stringify(tp)).not.toContain("secret-123");
    for (const name of ["signup_completed", "purchase_completed"]) {
      expect(await conversionOf("web-1", name)).toMatchObject({ attribution_event_id: touch.id, first_attribution_event_id: touch.id, last_non_direct_attribution_event_id: touch.id });
    }
    const r = await report("last_touch");
    expect(r.channels.find((c) => c.key === "email")).toMatchObject({ webTouches: 1, installs: 0, signups: 1, purchases: 1, revenue: [{ currency: "SAR", amount: 120 }] });
  });

  it("precedence: direct visits and organic reinstalls never take last-non-direct credit from a paid source", async () => {
    await sendW([
      webEv("page_viewed", "web-2", { gclid: "Cj0-paid-1", utm_source: "google", utm_medium: "cpc", utm_campaign: "brand" }, { timestamp: minutes(300) }),
      webEv("page_viewed", "web-2", { utm_source: "(direct)", utm_medium: "(none)" }, { timestamp: minutes(120) }),
      webEv("purchase_completed", "web-2", null, { timestamp: minutes(60), properties: { transaction_id: "w2", revenue: 80, currency: "SAR" } }),
    ]);
    const [paid, direct] = await touches("web-2");
    expect(paid).toMatchObject({ source: "google", match_type: "reported", match_key: "gclid", method: "network_click_reported" });
    expect(direct).toMatchObject({ match_type: "organic", match_key: "direct", method: "direct" });
    expect(await conversionOf("web-2")).toMatchObject({ attribution_event_id: direct.id, first_attribution_event_id: paid.id, last_non_direct_attribution_event_id: paid.id });

    // An app install with nothing to match (organic), after a paid install, by the same user.
    const c = await recorded(wLink.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '5 hours' where click_id = $1", [c.clickId]));
    await sendW([
      ev("app_installed", "app-2a", { user_id: "u-prec", timestamp: minutes(240), context: { platform: "android", attribution: { click_id: c.clickId } } }),
      ev("app_installed", "app-2b", { user_id: "u-prec", timestamp: minutes(100), context: { platform: "android" } }),
      ev("purchase_completed", "app-2b", { user_id: "u-prec", timestamp: minutes(50), properties: { transaction_id: "w2b", revenue: 40, currency: "SAR" } }),
    ]);
    const conv = await conversionOf("app-2b");
    const [first] = await touches("app-2a");
    const [reinstall] = await touches("app-2b");
    expect(first).toMatchObject({ kind: "install", match_type: "deterministic", method: "leanapp_click", confidence: "high" });
    expect(reinstall).toMatchObject({ kind: "reinstall", match_type: "organic", method: "none", confidence: "none" });
    expect(conv).toMatchObject({ attribution_event_id: reinstall.id, last_non_direct_attribution_event_id: first.id });

    const lnd = await report("last_non_direct");
    expect(lnd.model).toBe("last_non_direct");
    expect(lnd.channels.find((x) => x.key === "google_ads")?.purchases).toBe(1);
    expect(lnd.channels.find((x) => x.key === "meta_ads")?.purchases).toBe(1);
    const last = await report("last_touch");
    expect(last.channels.find((x) => x.key === "direct")?.purchases).toBe(1);
  });

  it("records method, evidence and confidence on every decision", async () => {
    const [install] = await touches("app-2a");
    expect(install.evidence).toMatchObject({ channel: "meta_ads", click_lookback_days: 7, limitations: [], touch_kind: "click" });
    expect((install.evidence.signals as string[])).toContain("click_id");
    const [paid] = await touches("web-2");
    expect(paid.evidence).toMatchObject({ channel: "google_ads", limitations: ["self_reported"], landing_host: null });
    const conv = await conversionOf("web-2");
    expect(conv!.credit_evidence).toMatchObject({ status: "credited", last_non_direct: { channel: "google_ads" }, last_touch: { channel: "direct" }, last_non_direct_fallback: false });
    const history = await withSystem((db) => db.query<{ reason: string }>("select reason from platform.attribution_conversion_credits where conversion_id = $1", [conv!.id]));
    expect(history).toEqual([{ reason: "initial" }]);
  });

  it("missing UTMs: a visit without campaign evidence is no touch, and its conversion is explicitly unattributed", async () => {
    await sendW([
      webEv("page_viewed", "web-3", { landing_url: "https://example.com/pricing", referrer: "https://example.com/" }, { timestamp: minutes(30) }),
      webEv("purchase_completed", "web-3", null, { timestamp: minutes(20), properties: { transaction_id: "w3", revenue: 10, currency: "SAR" } }),
    ]);
    expect(await touches("web-3")).toEqual([]);
    const conv = await conversionOf("web-3");
    expect(conv).toMatchObject({ attribution_event_id: null, last_non_direct_attribution_event_id: null });
    expect(conv!.credit_evidence).toMatchObject({ status: "no_touch", touches_considered: 0 });
    const r = await report("last_non_direct");
    expect(r.channels.find((c) => c.key === "unattributed")).toMatchObject({ purchases: 1, sourceClass: "unattributed" });
  });

  it("unknown sources: campaign data no rule recognises is an explicit unknown source, never direct", async () => {
    await sendW([
      webEv("page_viewed", "web-4", { utm_campaign: "mystery_campaign" }, { timestamp: minutes(30) }),
      webEv("page_viewed", "web-4", { utm_source: "(direct)" }, { timestamp: minutes(25) }),
      webEv("purchase_completed", "web-4", null, { timestamp: minutes(20), properties: { transaction_id: "w4", revenue: 5, currency: "SAR" } }),
    ]);
    const [unknown] = await touches("web-4");
    expect(unknown).toMatchObject({ source: null, match_type: "reported", match_key: "utm_parameters" });
    expect(await conversionOf("web-4")).toMatchObject({ last_non_direct_attribution_event_id: unknown.id });
    const r = await report("last_non_direct");
    expect(r.channels.find((c) => c.key === "unknown")).toMatchObject({ purchases: 1, webTouches: 1, sourceClass: "unknown" });
  });

  it("duplicates: a re-sent event and the same evidence in one visit are counted once", async () => {
    const page = webEv("page_viewed", "web-5", { utm_source: "partner_blog", utm_medium: "referral" }, { session_id: "s-5", timestamp: minutes(40) });
    await sendW([page]);
    const sdk = (await authenticateIngestionKey(w.sdkKey))!;
    const again = await ingest(sdk, { batch: [page] }, { mode: "batch" });
    expect((again.body as { accepted: number }).accepted).toBe(0);
    await sendW([
      // The SDK repeats the context on its landing event and on the first event of the next session.
      webEv("landing_viewed", "web-5", { utm_source: "partner_blog", utm_medium: "referral" }, { session_id: "s-5", timestamp: minutes(39) }),
      webEv("page_viewed", "web-5", { utm_source: "partner_blog", utm_medium: "referral", touch: "first" }, { session_id: "s-6", timestamp: minutes(5) }),
    ]);
    await processPendingEvents({ environmentId: w.dev.id });
    expect((await touches("web-5")).length).toBe(1);
    // The same evidence in a later session, 35 minutes on, is a new visit.
    await sendW([webEv("page_viewed", "web-5", { utm_source: "partner_blog", utm_medium: "referral" }, { session_id: "s-7", timestamp: minutes(4) })]);
    expect((await touches("web-5")).length).toBe(2);
  });

  it("delayed and out-of-order events: a touch processed after the conversion it precedes re-credits it, keeping history", async () => {
    await sendW([ev("purchase_completed", "late-1", { timestamp: minutes(10), context: { platform: "android" }, properties: { transaction_id: "l1", revenue: 60, currency: "SAR" } })]);
    const before = await conversionOf("late-1");
    expect(before).toMatchObject({ attribution_event_id: null, last_non_direct_attribution_event_id: null });
    // The install (an hour earlier on the device) arrives late.
    const c = await recorded(wLink.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '2 hours' where click_id = $1", [c.clickId]));
    await sendW([ev("app_installed", "late-1", { timestamp: minutes(70), context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    const [install] = await touches("late-1");
    const after = await conversionOf("late-1");
    expect(after).toMatchObject({ id: before!.id, attribution_event_id: install.id, first_attribution_event_id: install.id, last_non_direct_attribution_event_id: install.id });
    const history = await withSystem((db) => db.query<{ reason: string; last_non_direct_event_id: string | null }>(
      "select reason, last_non_direct_event_id from platform.attribution_conversion_credits where conversion_id = $1 order by decided_at, reason", [before!.id]));
    expect(history).toEqual([{ reason: "initial", last_non_direct_event_id: null }, { reason: "late_touch", last_non_direct_event_id: install.id }]);

    // A late direct visit changes the last touch but never the last non-direct credit.
    await sendW([webEv("page_viewed", "late-1", { utm_source: "direct" }, { timestamp: minutes(30) })]);
    const direct = (await touches("late-1")).find((x) => x.kind === "web_touch")!;
    expect(await conversionOf("late-1")).toMatchObject({ attribution_event_id: direct.id, last_non_direct_attribution_event_id: install.id });
    // Events older than the ingestion limit (31 days) are rejected, not attributed.
    const sdk = (await authenticateIngestionKey(w.sdkKey))!;
    const old = await ingest(sdk, { batch: [ev("app_installed", "late-2", { timestamp: new Date(Date.now() - 40 * 86_400_000).toISOString() })] }, { mode: "batch" });
    expect((old.body as { accepted: number }).accepted).toBe(0);
  });

  it("uses a channel's own click lookback and refuses invalid windows", async () => {
    const base = { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" };
    const c = await recorded(wLink.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '10 days' where click_id = $1", [c.clickId]));
    await sendW([ev("app_installed", "win-1", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    expect((await touches("win-1"))[0]).toMatchObject({ match_type: "organic" });

    await updateSettings(w.ctx, w.app.id, { ...base, windowOverrides: { meta_ads: { click_lookback_days: "14", conversion_window_days: "" } } });
    expect((await getSettings(w.ctx, w.app.id)).window_overrides).toEqual({ meta_ads: { click_lookback_days: 14 } });
    await sendW([ev("app_installed", "win-2", { context: { platform: "android", attribution: { click_id: c.clickId } } })]);
    const [matched] = await touches("win-2");
    expect(matched).toMatchObject({ match_type: "deterministic", source: "facebook" });
    expect(matched.evidence).toMatchObject({ channel: "meta_ads", click_lookback_days: 14 });
    // Other channels keep the app-wide window.
    const tiktok = await createLink(w.ctx, w.app.id, { environmentId: w.dev.id, name: "TikTok", source: "tiktok", androidUrl: "https://play.google.com/store/apps/details?id=com.example" });
    const t2 = await recorded(tiktok.code);
    await withSystem((db) => db.query("update platform.attribution_touchpoints set touchpoint_at = now() - interval '10 days' where click_id = $1", [t2.clickId]));
    await sendW([ev("app_installed", "win-3", { context: { platform: "android", attribution: { click_id: t2.clickId } } })]);
    expect((await touches("win-3"))[0]).toMatchObject({ match_type: "organic" });

    await expect(updateSettings(w.ctx, w.app.id, { ...base, windowOverrides: { meta_ads: { click_lookback_days: "120" } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(w.ctx, w.app.id, { ...base, windowOverrides: { not_a_channel: { click_lookback_days: "3" } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(w.ctx, w.app.id, { ...base, reportingModel: "last_non_direct" })).resolves.toBeUndefined();
    const s = await getSettings(w.ctx, w.app.id);
    expect(s).toMatchObject({ reporting_model: "last_non_direct", window_overrides: { meta_ads: { click_lookback_days: 14 } } });
    expect((await channelReport(w.ctx, { appId: w.app.id, environmentId: w.dev.id, timezone: "UTC", includeSpend: false }, { days: 30 })).model).toBe("last_non_direct");
  });

  it("keeps attribution data of tenants apart", async () => {
    // Another tenant's web visit carrying this tenant's LeanApp click id never matches it.
    const c = await recorded(wLink.code, { ua: DESKTOP });
    await send([webEv("page_viewed", "x-web", { click_id: c.clickId, utm_source: "facebook" })], { key: other.sdkKey });
    const row = await withSystem((db) => db.one<{ match_type: string; link_id: string | null }>(
      "select match_type, link_id from platform.attribution_events where environment_id = $1 and anonymous_id = 'x-web'", [other.dev.id]));
    expect(row).toEqual({ match_type: "reported", link_id: null });
    // This tenant's own web visit with it is deterministic.
    await sendW([webEv("page_viewed", "own-web", { click_id: c.clickId, utm_source: "facebook" })]);
    expect((await touches("own-web"))[0]).toMatchObject({ match_type: "deterministic", match_key: "click_id", method: "leanapp_click" });

    // Reports, settings and credit history of one tenant are invisible to another.
    const r = await report("last_non_direct", other.ctx);
    expect(r.totals).toMatchObject({ webTouches: 0, installs: 0, conversions: 0 });
    await expect(updateSettings(other.ctx, w.app.id, { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90 })).rejects.toBeInstanceOf(NotFoundError);
    const visible = await tenantTx(other.ctx, "attribution.read", (db) =>
      db.one<{ credits: string; events: string; conversions: string }>(
        `select (select count(*) from platform.attribution_conversion_credits where environment_id = $1) as credits,
                (select count(*) from platform.attribution_events where environment_id = $1) as events,
                (select count(*) from platform.attribution_conversions where environment_id = $1) as conversions`,
        [w.dev.id],
      ));
    expect(visible).toEqual({ credits: "0", events: "0", conversions: "0" });
    const own = await tenantTx(w.ctx, "attribution.read", (db) =>
      db.one<{ credits: string }>("select count(*) as credits from platform.attribution_conversion_credits where environment_id = $1", [w.dev.id]));
    expect(Number(own!.credits)).toBeGreaterThan(5);
  });
});

// ── Apple Search Ads (AdServices) answers as provider-reported attribution (0039b) ─
describe("Apple Search Ads (AdServices) attribution", () => {
  let a: T;
  const token = (n: number) => `${"R".repeat(120)}${n}XyZw+/==`;
  const ios = (anon: string, attribution: Record<string, string> = {}, o: Record<string, unknown> = {}) =>
    ev("app_installed", anon, { context: { platform: "ios", os_version: "17.4", attribution }, ...o });
  const install = (anon: string) => withSystem((db) => db.query<{
    id: string; kind: string; match_type: string; match_key: string | null; method: string | null; confidence: string | null; source: string | null; campaign: string | null;
    touchpoint_id: string | null; evidence: Record<string, unknown>;
  }>(
    "select id, kind, match_type, match_key, method, confidence, source, campaign, touchpoint_id, evidence from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind in ('install', 'reinstall')",
    [a.dev.id, anon],
  ));
  const credits = (anon: string) => withSystem((db) => db.query<{ reason: string; last_non_direct_event_id: string | null }>(
    `select cc.reason, cc.last_non_direct_event_id from platform.attribution_conversion_credits cc
       join platform.attribution_conversions c on c.id = cc.conversion_id join platform.events e on e.id = c.event_row_id
      where c.environment_id = $1 and e.anonymous_id = $2 order by cc.decided_at, cc.reason`,
    [a.dev.id, anon],
  ));
  const apple = (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    if (body === token(1) || body === token(3)) {
      return Response.json({ attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, adId: 542317136, countryOrRegion: "SA", conversionType: "Download", claimType: "Click" });
    }
    return Response.json({ attribution: false });
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    a = await makeTenant("attr-asa");
  });

  it("upgrades the unattributed iOS install once, re-credits its conversions, and never overrides a LeanApp click match", async () => {
    const link = await createLink(a.ctx, a.app.id, { environmentId: a.dev.id, name: "Web", source: "tiktok", iosUrl: "https://apps.apple.com/app/id1" });
    const c = await recorded(link.code, { ua: IPHONE });
    await send([
      ios("asa-1", { adservices_token: token(1) }, { user_id: "u-asa-1" }),
      ios("asa-2", { adservices_token: token(2) }),
      ios("asa-3", { adservices_token: token(3), click_id: c.clickId }),
    ], { key: a.sdkKey });
    await send([
      ev("purchase_completed", "asa-1", { user_id: "u-asa-1", properties: { transaction_id: "asa-p1", revenue: 30, currency: "SAR" } }),
      ev("purchase_completed", "asa-2", { properties: { transaction_id: "asa-p2", revenue: 20, currency: "SAR" } }),
    ], { key: a.sdkKey });
    const [before] = await install("asa-1");
    expect(before).toMatchObject({ match_type: "organic", method: "none" });

    // The scan leaves events younger than two minutes for its next run (any tenant's).
    await withSystem((db) => db.query("update platform.events set received_at = now() - interval '5 minutes' where received_at > now() - interval '5 minutes'"));
    expect(await queueAdServicesTokens()).toMatchObject({ queued: 3 });
    expect(await processAdServicesLookups({ fetchImpl: apple })).toMatchObject({ attributed: 2, notAttributed: 1 });

    // asa-1: the same row, upgraded in place, with what it was kept.
    const rows = await install("asa-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before.id, kind: "install", match_type: "provider_reported", match_key: "adservices", method: "adservices", confidence: "high", source: "apple_search_ads", campaign: "542370539",
    });
    expect(rows[0].evidence).toMatchObject({
      channel: "apple_search_ads", evidence_level: "provider_reported", limitations: ["provider_reported"],
      apple: { campaign_id: "542370539", ad_group_id: "542317095", keyword_id: "87675432", ad_id: "542317136", claim_type: "Click" },
      upgraded_from: { match_type: "organic", method: "none", confidence: "none", source: null },
    });
    const tp = await withSystem((db) => db.one<{ provider: string; campaign_id: string; ad_group_id: string; creative_id: string }>(
      "select provider, campaign_id, ad_group_id, creative_id from platform.attribution_touchpoints where id = $1", [rows[0].touchpoint_id]));
    expect(tp).toEqual({ provider: "apple_adservices", campaign_id: "542370539", ad_group_id: "542317095", creative_id: "542317136" });
    // Its purchase now credits Apple Search Ads in the last non-direct view, with the history kept.
    expect(await credits("asa-1")).toEqual([{ reason: "initial", last_non_direct_event_id: before.id }, { reason: "provider_reported", last_non_direct_event_id: before.id }]);
    const conv = await withSystem((db) => db.one<{ credit_evidence: Record<string, unknown> }>(
      "select c.credit_evidence from platform.attribution_conversions c join platform.events e on e.id = c.event_row_id where c.environment_id = $1 and e.anonymous_id = 'asa-1'", [a.dev.id]));
    expect(conv!.credit_evidence).toMatchObject({ last_non_direct_fallback: false, reason: "provider_reported", last_non_direct: { channel: "apple_search_ads" } });

    // asa-2: Apple said not attributed: nothing changes.
    expect((await install("asa-2"))[0]).toMatchObject({ match_type: "organic", source: null });
    expect((await credits("asa-2")).map((r) => r.reason)).toEqual(["initial"]);

    // asa-3: a LeanApp click matched it; Apple's answer is stored but doesn't override it.
    expect((await install("asa-3"))[0]).toMatchObject({ match_type: "deterministic", source: "tiktok" });

    // Applying again changes nothing (upgraded once).
    const lookup = await withSystem((db) => db.one<{ id: string }>("select id from platform.adservices_attributions where environment_id = $1 and anonymous_id = 'asa-1'", [a.dev.id]));
    expect(await withSystem((db) => applyAdServicesAttribution(db, lookup!.id))).toBe("kept_existing_match");
    expect(await credits("asa-1")).toHaveLength(2);

    // Reports: one install, provider-reported, on the Apple Search Ads channel.
    const r = await channelReport(a.ctx, { appId: a.app.id, environmentId: a.dev.id, timezone: "UTC", includeSpend: false }, { days: 30, model: "last_non_direct" });
    expect(r.channels.find((x) => x.key === "apple_search_ads")).toMatchObject({ installs: 1, purchases: 1, sourceClass: "paid", evidence: { provider_reported: 1 } });
    const overview = await attributionOverview(a.ctx, { environmentId: a.dev.id, timezone: "UTC" }, { days: 30 });
    expect(overview.totals).toMatchObject({ installs: 3, provider_reported: 1, deterministic: 1 });
    expect(overview.totals.attributed).toBe(overview.totals.deterministic + overview.totals.reported + overview.totals.probabilistic + overview.totals.provider_reported);
  });

  it("uses an answer already stored when the install is processed after it", async () => {
    const sdk = (await authenticateIngestionKey(a.sdkKey))!;
    await ingest(sdk, { batch: [ios("asa-4", { adservices_token: token(5) })] }, { mode: "batch" });
    await withSystem((db) => db.query(
      `insert into platform.adservices_attributions (organization_id, app_id, environment_id, anonymous_id, token_hash, token_received_at, status, campaign_id, ad_group_id, keyword_id, claim_type, looked_up_at)
       values ($1, $2, $3, 'asa-4', 'hash-asa-4', now(), 'attributed', 111, 222, 333, 'Impression', now())`,
      [a.org.id, a.app.id, a.dev.id],
    ));
    await processPendingEvents({ environmentId: a.dev.id });
    const [row] = await install("asa-4");
    expect(row).toMatchObject({ match_type: "provider_reported", match_key: "adservices", method: "adservices", confidence: "medium", source: "apple_search_ads", campaign: "111" });
    expect(row.evidence).toMatchObject({ limitations: ["provider_reported", "view_through"], apple: { ad_group_id: "222", keyword_id: "333" } });
    expect(row.evidence.upgraded_from).toBeUndefined();
  });
});
