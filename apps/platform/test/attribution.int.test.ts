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
import { attributionOverview } from "@/modules/attribution/reports";
import {
  CLICKS_PER_IP_PER_MINUTE, createLink, createPostback, handleClick, listLinks, listPostbacks, setLinkStatus, setPostbackStatus, updateSettings, type LinkRow,
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
    expect(r).toEqual({ succeeded: 1, retrying: 1, failed: 0 });
    const retry = await withSystem((db) => db.one<{ attempts: number; status: string; last_status_code: number; due: boolean }>(
      "select attempts, status, last_status_code, next_attempt_at > now() + interval '50 seconds' as due from platform.attribution_postback_deliveries where postback_id = $1 and status = 'pending'", [pb.id]));
    expect(retry).toMatchObject({ attempts: 1, status: "pending", last_status_code: 503, due: true });
    expect(await deliverPostbacks()).toEqual({ succeeded: 0, retrying: 0, failed: 0 }); // not due yet
    await withSystem((db) => db.query("update platform.attribution_postback_deliveries set next_attempt_at = now() where postback_id = $1 and status = 'pending'", [pb.id]));
    r = await deliverPostbacks();
    expect(r).toEqual({ succeeded: 1, retrying: 0, failed: 0 });

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
    expect(await deliverPostbacks()).toEqual({ succeeded: 0, retrying: 0, failed: 1 });
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
    expect(await deliverPostbacks({ fetchImpl: fake })).toEqual({ succeeded: 1, retrying: 0, failed: 0 });
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
