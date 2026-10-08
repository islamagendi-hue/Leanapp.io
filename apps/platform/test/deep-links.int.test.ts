/**
 * Deep linking against Postgres: link domain configuration (validation, permissions,
 * tenant isolation), apple-app-site-association / assetlinks.json content and headers
 * per host, /l/{prefix}/{code}, the social in-app browser page, the resolve endpoint
 * (auth, environment and tenant isolation, click reuse, re-engagement), deferred deep
 * links (deterministic, once per install, one install per click, probabilistic opt-in,
 * no leak across environments) and the well-known "Test" check.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as aasaRoute } from "@/app/.well-known/apple-app-site-association/route";
import { GET as assetLinksRoute } from "@/app/.well-known/assetlinks.json/route";
import { GET as linkRoute } from "@/app/l/[code]/route";
import { GET as prefixedLinkRoute } from "@/app/l/[code]/[slug]/route";
import { GET as resolveRoute } from "@/app/v1/deep-links/resolve/route";
import { POST as deferredRoute } from "@/app/v1/deep-links/deferred/route";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { createLink, updateSettings, type LinkRow } from "@/modules/attribution/service";
import { authenticateIngestionKey, listKeys } from "@/modules/credentials/service";
import { deepLinkReport } from "@/modules/deeplinks/report";
import { checkWellKnown, getConfig, saveConfig } from "@/modules/deeplinks/service";
import { ingest } from "@/modules/ingestion/service";
import { exportSubjectData, requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let prod: { id: string };
let prodKey: string;
let link: LinkRow;
let prodLink: LinkRow;
let otherLink: LinkRow;

const FP = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const INSTAGRAM_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 324.0.3.21.98 (iPhone15,2; iOS 17_4; ar_SA)";
const TIKTOK_ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 musical_ly_2023405030 BytedanceWebview/d8a21c6";

// The link host serves the routes under test, so the "Test" button fetches them for real.
let server: Server;
let linkBase = "";
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;

const linkCtx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) }) as never;

function get(path: string, o: { ua?: string; host?: string; ip?: string; lang?: string } = {}) {
  const headers: Record<string, string> = { "user-agent": o.ua ?? ANDROID, "x-forwarded-for": o.ip ?? nextIp() };
  if (o.host) headers.host = o.host;
  if (o.lang) headers["accept-language"] = o.lang;
  return new Request(`${linkBase}${path}`, { headers });
}

function resolve(url: string, key: string | null, o: { anon?: string; platform?: string; ip?: string } = {}) {
  const q = new URLSearchParams({ url, ...(o.anon ? { anonymous_id: o.anon } : {}), ...(o.platform ? { platform: o.platform } : {}) });
  return resolveRoute(new Request(`http://localhost/v1/deep-links/resolve?${q}`, {
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "x-forwarded-for": o.ip ?? nextIp(), "user-agent": "Shop/2.3 (Android 14)" },
  }));
}

function deferred(key: string, body: Record<string, unknown>, ip = nextIp()) {
  return deferredRoute(new Request("http://localhost/v1/deep-links/deferred", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  }));
}

async function clickOf(clickId: string) {
  return withSystem((db) => db.one<{ link_id: string; anonymous_id: string | null; kind: string; raw: Record<string, unknown>; environment_id: string }>(
    "select link_id, anonymous_id, kind, raw, environment_id from platform.attribution_touchpoints where click_id = $1", [clickId]));
}

const config = (environmentId: string, extra: Record<string, unknown> = {}) => ({
  environmentId,
  linkPrefix: "shop-dev",
  iosTeamId: "abcde12345",
  iosBundleIds: "com.shop.app.dev, com.shop.app.dev.clip",
  iosAppStoreId: "id1234567",
  uriScheme: "shopdev",
  androidPackage: "com.shop.app.dev",
  androidSha256: FP.toLowerCase(),
  deferredEnabled: "on",
  interstitialEnabled: "on",
  ...extra,
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const request = new Request(`http://127.0.0.1${req.url}`, { headers: { host: req.headers.host ?? "" } });
    const out = path === "/.well-known/apple-app-site-association" ? await aasaRoute(request)
      : path === "/.well-known/assetlinks.json" ? await assetLinksRoute(request)
      : new Response("not found", { status: 404 });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(await out.text());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  linkBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_LINK_URL = linkBase;

  t = await makeTenant("dl");
  other = await makeTenant("dl-other");
  prod = t.environments.find((e) => e.type === "production")!;
  prodKey = (await listKeys(t.ctx, t.app.id)).sdkKeys.find((k) => k.environment_id === prod.id)!.key;
  const dest = { iosUrl: "https://apps.apple.com/app/id1234567", androidUrl: "https://play.google.com/store/apps/details?id=com.shop.app" };
  link = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "Ramadan IG", source: "instagram", medium: "social", campaign: "ramadan", deepLinkPath: "/offers/ramadan?tab=deals", ...dest });
  prodLink = await createLink(t.ctx, t.app.id, { environmentId: prod.id, name: "Prod email", source: "email", medium: "email", deepLinkPath: "/inbox", ...dest });
  otherLink = await createLink(other.ctx, other.app.id, { environmentId: other.dev.id, name: "Other", source: "sms", deepLinkPath: "/secret", ...dest });
});

afterAll(async () => {
  delete process.env.PUBLIC_LINK_URL;
  await new Promise((r) => server.close(r));
});

describe("configuration", () => {
  it("validates and normalizes the iOS and Android settings", async () => {
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { linkPrefix: "A!" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { linkPrefix: "api" }))).rejects.toThrow(/reserved/);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { iosTeamId: "short" }))).rejects.toThrow(/Team ID/);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { androidSha256: "AB:CD" }))).rejects.toThrow(/SHA-256/);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { iosTeamId: "" }))).rejects.toThrow(/Team ID for the bundle ids/);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { customDomain: "https://links.example.com:8443/x" }))).rejects.toThrow(/Custom domain/);
    const c = await saveConfig(t.ctx, t.app.id, config(t.dev.id));
    expect(c).toMatchObject({
      link_prefix: "shop-dev", custom_domain: null, ios_team_id: "ABCDE12345", ios_bundle_ids: ["com.shop.app.dev", "com.shop.app.dev.clip"], ios_app_store_id: "1234567",
      uri_scheme: "shopdev", android_package: "com.shop.app.dev", android_sha256: [FP], deferred_enabled: true, interstitial_enabled: true,
    });
    await saveConfig(t.ctx, t.app.id, config(prod.id, { linkPrefix: "shop", iosBundleIds: "com.shop.app", androidPackage: "com.shop.app", uriScheme: "shop" }));
    const log = await withSystem((db) => db.query("select action from platform.audit_logs where organization_id = $1 and action = 'deep_links.config_updated'", [t.org.id]));
    expect(log.length).toBe(2);
  });

  it("keeps prefixes and custom domains to one owner", async () => {
    await expect(saveConfig(other.ctx, other.app.id, config(other.dev.id, { linkPrefix: "shop" }))).rejects.toThrow(/already taken/);
    await saveConfig(other.ctx, other.app.id, config(other.dev.id, { linkPrefix: "rides", customDomain: "go.rides.example", iosBundleIds: "com.rides", androidPackage: "com.rides" }));
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { customDomain: "go.rides.example" }))).rejects.toThrow(/another organization/);
    await expect(saveConfig(t.ctx, t.app.id, config(t.dev.id, { customDomain: "l.leanapp.io" }))).rejects.toThrow(/LeanApp link host/);
  });

  it("enforces permissions and tenant isolation", async () => {
    const analyst: TenantContext = { ...t.ctx, role: "analyst" };
    const developer: TenantContext = { ...t.ctx, role: "developer" };
    expect((await getConfig(analyst, t.app.id, t.dev.id))?.link_prefix).toBe("shop-dev");
    await expect(saveConfig(analyst, t.app.id, config(t.dev.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveConfig(developer, t.app.id, config(t.dev.id))).resolves.toMatchObject({ link_prefix: "shop-dev" });
    // Another organization sees nothing and can't write into this app.
    expect(await getConfig(other.ctx, t.app.id, t.dev.id)).toBeNull();
    await expect(saveConfig(other.ctx, t.app.id, config(t.dev.id, { linkPrefix: "hijack" }))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("well-known files", () => {
  it("serves apple-app-site-association on the link host for every app using it, scoped by prefix", async () => {
    const res = await aasaRoute(get("/.well-known/apple-app-site-association", { host: new URL(linkBase).host }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] } };
    const mine = body.applinks.details.filter((d) => d.appIDs.some((a) => a.startsWith("ABCDE12345.com.shop")));
    expect(mine).toEqual([
      { appIDs: ["ABCDE12345.com.shop.app"], components: [{ "/": "/l/shop/*", comment: "LeanApp links (production)" }] },
      { appIDs: ["ABCDE12345.com.shop.app.dev", "ABCDE12345.com.shop.app.dev.clip"], components: [{ "/": "/l/shop-dev/*", comment: "LeanApp links (development)" }] },
    ]);
    // The other organization's app is on its own custom domain, not on the shared host.
    expect(JSON.stringify(body)).not.toContain("com.rides");
  });

  it("serves a custom domain only its own apps, and nothing on unrelated hosts", async () => {
    const custom = await aasaRoute(get("/.well-known/apple-app-site-association", { host: "go.rides.example" }));
    expect(custom.status).toBe(200);
    expect(JSON.stringify(await custom.json())).toBe(JSON.stringify({ applinks: { details: [{ appIDs: ["ABCDE12345.com.rides"], components: [{ "/": "/l/rides/*", comment: "LeanApp links (development)" }] }] } }));
    const none = await aasaRoute(get("/.well-known/apple-app-site-association", { host: "unrelated.example" }));
    expect(none.status).toBe(404);
    expect(none.headers.get("content-type")).toBe("application/json");
  });

  it("serves assetlinks.json with every Android app of the host", async () => {
    const res = await assetLinksRoute(get("/.well-known/assetlinks.json", { host: new URL(linkBase).host }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    expect(body.filter((s) => s.target.package_name.startsWith("com.shop")).map((s) => s.target)).toEqual([
      { namespace: "android_app", package_name: "com.shop.app", sha256_cert_fingerprints: [FP] },
      { namespace: "android_app", package_name: "com.shop.app.dev", sha256_cert_fingerprints: [FP] },
    ]);
    expect((await assetLinksRoute(get("/.well-known/assetlinks.json", { host: "unrelated.example" }))).status).toBe(404);
  });

  it("checks the files from outside (the dashboard's Test button) and stores the result", async () => {
    const results = await checkWellKnown(t.ctx, t.app.id, t.dev.id);
    expect(results.map((r) => [r.file, r.ok, r.status, r.problems])).toEqual([
      ["apple-app-site-association", true, 200, []],
      ["assetlinks.json", true, 200, []],
    ]);
    expect((await getConfig(t.ctx, t.app.id, t.dev.id))!.last_check).toHaveLength(2);
    // A host that redirects or serves the wrong type fails with the reason.
    const fake = (async (url: string) => (String(url).includes("apple") ? new Response(null, { status: 301, headers: { location: "https://www.example.com/x" } }) : new Response("[]", { headers: { "content-type": "text/plain" } }))) as typeof fetch;
    const bad = await checkWellKnown(t.ctx, t.app.id, t.dev.id, fake);
    expect(bad[0].problems[0]).toMatch(/Redirects \(HTTP 301\)/);
    expect(bad[1].problems).toEqual(['Content-Type is "text/plain"; it must be application/json.', "com.shop.app.dev is not listed with delegate_permission/common.handle_all_urls."]);
    await expect(checkWellKnown({ ...t.ctx, role: "analyst" }, t.app.id, t.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("link redirects and the in-app browser page", () => {
  it("serves links under the environment's prefix and 404s other prefixes", async () => {
    const ok = await prefixedLinkRoute(get(`/l/shop-dev/${link.code}`, { ua: IPHONE }), linkCtx({ code: "shop-dev", slug: link.code }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://apps.apple.com/app/id1234567");
    expect((await prefixedLinkRoute(get(`/l/shop/${link.code}`), linkCtx({ code: "shop", slug: link.code }))).status).toBe(404);
    expect((await prefixedLinkRoute(get(`/l/rides/${link.code}`), linkCtx({ code: "rides", slug: link.code }))).status).toBe(404);
    // The plain /l/{code} keeps working.
    expect((await linkRoute(get(`/l/${link.code}`), linkCtx({ code: link.code }))).status).toBe(302);
  });

  it("shows Instagram on iOS an Open-in-app page with the URL scheme and the App Store, under a nonce CSP", async () => {
    const res = await prefixedLinkRoute(get(`/l/shop-dev/${link.code}`, { ua: INSTAGRAM_IOS }), linkCtx({ code: "shop-dev", slug: link.code }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(csp).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toContain("<script");
    const open = /class="primary" href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const u = new URL(open);
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("shopdev://offers/ramadan");
    expect(u.searchParams.get("tab")).toBe("deals");
    expect(u.searchParams.get("utm_source")).toBe("instagram");
    const clickId = u.searchParams.get("click_id")!;
    expect(await clickOf(clickId)).toMatchObject({ link_id: link.id, kind: "click" });
    expect(html).toContain('href="https://apps.apple.com/app/id1234567"');
  });

  it("gives TikTok on Android an intent link to the verified app with the Play Store fallback, in Arabic when asked", async () => {
    const res = await linkRoute(get(`/l/${link.code}`, { ua: TIKTOK_ANDROID, lang: "ar-SA,ar;q=0.9" }), linkCtx({ code: link.code }));
    const html = await res.text();
    expect(html).toContain('dir="rtl"');
    const open = /class="primary" href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    expect(open).toMatch(new RegExp(`^intent://127\\.0\\.0\\.1:\\d+/l/shop-dev/${link.code}\\?click_id=lac_[A-Za-z0-9_-]+#Intent;scheme=http;package=com\\.shop\\.app\\.dev;S\\.browser_fallback_url=https%3A%2F%2Fplay\\.google\\.com`));
  });

  it("redirects real browsers, and in-app browsers when the page is off or the environment has no deep link setup", async () => {
    expect((await linkRoute(get(`/l/${link.code}`, { ua: IPHONE }), linkCtx({ code: link.code }))).status).toBe(302);
    expect((await linkRoute(get(`/l/${otherLink.code}`, { ua: INSTAGRAM_IOS }), linkCtx({ code: otherLink.code }))).status).toBe(200); // other org has a config
    await saveConfig(t.ctx, t.app.id, config(t.dev.id, { interstitialEnabled: "" }));
    expect((await linkRoute(get(`/l/${link.code}`, { ua: INSTAGRAM_IOS }), linkCtx({ code: link.code }))).status).toBe(302);
    await saveConfig(t.ctx, t.app.id, config(t.dev.id));
  });
});

describe("resolve (installed app opened with a link)", () => {
  it("requires an SDK key", async () => {
    expect((await resolve(`${linkBase}/l/shop-dev/${link.code}`, null)).status).toBe(401);
    expect((await resolve(`${linkBase}/l/shop-dev/${link.code}`, "la_pk_dev_" + "x".repeat(32))).status).toBe(401);
  });

  it("returns the deep link and campaign and records the open as a click of this install", async () => {
    const res = await resolve(`${linkBase}/l/shop-dev/${link.code}?utm_content=story_3&promo=EID`, t.sdkKey, { anon: "anon-resolve-1", platform: "ios" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { click_id: string; deep_link: unknown; campaign: unknown; link: unknown; is_deferred: boolean };
    expect(body).toMatchObject({
      link: { code: link.code, name: "Ramadan IG" },
      deep_link: { path: "/offers/ramadan", params: { promo: "EID", tab: "deals" }, url: "/offers/ramadan?promo=EID&tab=deals" },
      campaign: { source: "instagram", medium: "social", campaign: "ramadan", creative: "story_3" },
      is_deferred: false,
    });
    expect(await clickOf(body.click_id)).toMatchObject({ link_id: link.id, anonymous_id: "anon-resolve-1", kind: "click", raw: { via: "app_link" } });
  });

  it("reuses the click the interstitial already recorded", async () => {
    const page = await (await linkRoute(get(`/l/${link.code}`, { ua: TIKTOK_ANDROID }), linkCtx({ code: link.code }))).text();
    const clickId = /click_id=(lac_[A-Za-z0-9_-]+)/.exec(page)![1];
    const body = (await (await resolve(`${linkBase}/l/shop-dev/${link.code}?click_id=${clickId}`, t.sdkKey, { anon: "anon-resolve-2" })).json()) as { click_id: string };
    expect(body.click_id).toBe(clickId);
    expect((await clickOf(clickId))!.anonymous_id).toBe("anon-resolve-2");
  });

  it("never resolves another environment's or organization's links, or foreign hosts", async () => {
    expect((await resolve(`${linkBase}/l/shop-dev/${link.code}`, prodKey)).status).toBe(404); // dev link, production key
    expect((await resolve(`${linkBase}/l/shop/${prodLink.code}`, t.sdkKey)).status).toBe(404); // production link, dev key
    expect((await resolve(`${linkBase}/l/${otherLink.code}`, t.sdkKey)).status).toBe(404);
    expect((await resolve(`https://go.rides.example/l/rides/${otherLink.code}`, t.sdkKey)).status).toBe(404);
    expect((await resolve(`https://evil.example/l/shop-dev/${link.code}`, t.sdkKey)).status).toBe(404);
    expect((await resolve("not a url", t.sdkKey)).status).toBe(422);
    const ok = await resolve(`${linkBase}/l/shop/${prodLink.code}`, prodKey);
    expect(((await ok.json()) as { deep_link: { path: string } }).deep_link.path).toBe("/inbox");
    // The other organization resolves its own link on its custom domain.
    const theirs = await resolve(`https://go.rides.example/l/rides/${otherLink.code}`, other.sdkKey);
    expect(((await theirs.json()) as { deep_link: { path: string } }).deep_link.path).toBe("/secret");
  });

  it("turns the SDK's deep_link_opened into a re-engagement of an existing install", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const anon = "anon-reengage";
    const send = async (events: Record<string, unknown>[]) => {
      await ingest(sdk, { batch: events }, { mode: "batch" });
      await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
    };
    await send([{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: anon, timestamp: new Date(Date.now() - 86_400_000).toISOString() }]);
    const body = (await (await resolve(`${linkBase}/l/shop-dev/${link.code}`, t.sdkKey, { anon })).json()) as { click_id: string };
    await send([{
      type: "track", event_name: "deep_link_opened", event_id: crypto.randomUUID(), anonymous_id: anon,
      properties: { url: `${linkBase}/l/shop-dev/${link.code}`, path: "/offers/ramadan" },
      context: { attribution: { click_id: body.click_id, utm_source: "instagram", deep_link_url: `${linkBase}/l/shop-dev/${link.code}` } },
    }]);
    const re = await withSystem((db) => db.one("select kind, match_type, match_key, link_id, source from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind = 're_engagement'", [t.dev.id, anon]));
    expect(re).toMatchObject({ kind: "re_engagement", match_type: "deterministic", match_key: "click_id", link_id: link.id, source: "instagram" });
  });
});

describe("deferred deep links", () => {
  async function androidClick(l: LinkRow, ip: string) {
    const res = await linkRoute(get(`/l/${l.code}`, { ua: ANDROID, ip }), linkCtx({ code: l.code }));
    const referrer = new URL(res.headers.get("location")!).searchParams.get("referrer")!;
    return { referrer, clickId: new URLSearchParams(referrer).get("click_id")! };
  }

  it("returns the clicked link's deep link from the Play install referrer, once per install", async () => {
    const { referrer, clickId } = await androidClick(link, nextIp());
    const res = await deferred(t.sdkKey, { anonymous_id: "anon-deferred-1", install_referrer: referrer, platform: "android", os_version: "14" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      match_type: "deterministic", match_key: "install_referrer", is_deferred: true, click_id: clickId,
      link: { code: link.code }, deep_link: { path: "/offers/ramadan", params: { tab: "deals" } }, campaign: { source: "instagram", campaign: "ramadan" },
    });
    // Once per install.
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-deferred-1", install_referrer: referrer })).json()).toMatchObject({ match_type: "none", reason: "already_checked", deep_link: null });
    // A click goes to one install only.
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-deferred-2", install_referrer: referrer })).json()).toMatchObject({ match_type: "none", reason: "no_click" });
  });

  it("does not leak across environments or organizations", async () => {
    const { referrer } = await androidClick(link, nextIp());
    expect(await (await deferred(prodKey, { anonymous_id: "anon-prod-1", install_referrer: referrer })).json()).toMatchObject({ match_type: "none", deep_link: null });
    expect(await (await deferred(other.sdkKey, { anonymous_id: "anon-other-1", install_referrer: referrer })).json()).toMatchObject({ match_type: "none", deep_link: null });
    // The click is still available to an install in its own environment.
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-dev-3", install_referrer: referrer })).json()).toMatchObject({ match_type: "deterministic" });
  });

  it("matches probabilistically only when enabled, only on Android, and says so", async () => {
    const ip = "203.0.113.200";
    await androidClick(link, ip);
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-prob-1", platform: "android", os_version: "14" }, ip)).json()).toMatchObject({ match_type: "none", reason: "no_click" });
    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticEnabled: "on", probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" });
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-prob-ios", platform: "ios", os_version: "14" }, ip)).json()).toMatchObject({ match_type: "none" });
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-prob-2", platform: "android", os_version: "13" }, ip)).json()).toMatchObject({ match_type: "none" }); // other Android version
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-prob-3", platform: "android", os_version: "14.1" }, ip)).json())
      .toMatchObject({ match_type: "probabilistic", match_key: "ip_os", deep_link: { path: "/offers/ramadan" } });
    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticEnabled: "", probabilisticWindowHours: 24, conversionWindowDays: 90, reengagementEnabled: "on" });
  });

  it("can be turned off per environment and validates its input", async () => {
    await saveConfig(t.ctx, t.app.id, config(t.dev.id, { deferredEnabled: "" }));
    const { referrer } = await androidClick(link, nextIp());
    expect(await (await deferred(t.sdkKey, { anonymous_id: "anon-off", install_referrer: referrer })).json()).toMatchObject({ match_type: "none", reason: "disabled" });
    await saveConfig(t.ctx, t.app.id, config(t.dev.id));
    expect((await deferred(t.sdkKey, {})).status).toBe(422);
  });

  it("is part of the install's privacy export and deletion", async () => {
    const req = { kind: "user" as const, ctx: t.ctx };
    const x = await exportSubjectData(req, t.dev.id, { anonymousId: "anon-deferred-1" });
    expect(x.data.deferred_deep_links).toHaveLength(1);
    const { jobId } = await requestDeletion(req, t.dev.id, { anonymousId: "anon-deferred-1" });
    expect(await runDeletionJobs({ jobIds: [jobId] })).toEqual({ completed: 1, failed: 0 });
    const rows = await withSystem((db) => db.query("select 1 from platform.deep_link_deferred_matches where environment_id = $1 and anonymous_id = 'anon-deferred-1'", [t.dev.id]));
    expect(rows).toHaveLength(0);
  });
});

describe("deep link report (Acquisition → Deep links)", () => {
  it("counts clicks and deferred matches per link with a deep link, in its own environment and organization only", async () => {
    await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "No deep link", source: "sms", webUrl: "https://example.com" });
    const r = await deepLinkReport(t.ctx, t.dev.id, 30);
    expect(r.days).toBe(30);
    expect(r.links.map((l) => l.name)).toEqual(["Ramadan IG"]);
    const ramadan = r.links[0];
    expect(ramadan.deep_link_path).toBe("/offers/ramadan?tab=deals");
    expect(ramadan.clicks).toBeGreaterThan(0);
    // anon-dev-3 (exact) and anon-prob-3 (probabilistic); anon-deferred-1 was deleted by its privacy request.
    expect(ramadan.deferred).toBe(2);
    expect(r.deferred).toMatchObject({ deterministic: 1, probabilistic: 1 });
    expect(r.deferred.none).toBeGreaterThan(0);

    expect((await deepLinkReport(t.ctx, prod.id, 7)).links.map((l) => l.name)).toEqual(["Prod email"]);
    expect((await deepLinkReport(other.ctx, t.dev.id, 30)).links).toEqual([]);
  });
});
