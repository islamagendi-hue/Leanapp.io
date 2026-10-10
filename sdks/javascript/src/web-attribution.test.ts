import { afterEach, describe, expect, it, vi } from "vitest";
import { LeanAppClient, memoryStorage, parseAttribution, webTouch, type DeferredDeepLink, type StorageAdapter, type WireEvent } from "./index.js";

const KEY = "la_pk_dev_abcdefghijklmnopqrstuvwx";
const T0 = Date.parse("2026-10-05T10:00:00Z");

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Answers /v1/events/batch and /v1/deep-links/deferred; records both. */
function server(deferred: (n: number) => { status: number; body?: unknown } = () => ({ status: 200, body: { match_type: "none", reason: "no_click", deep_link: null, is_deferred: true } })) {
  const calls: Call[] = [];
  let deferredCalls = 0;
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    if (url.endsWith("/v1/deep-links/deferred")) {
      const r = deferred(++deferredCalls);
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }
    const batch = body.batch as unknown[];
    return new Response(JSON.stringify({ accepted: batch.length, duplicates: 0, rejected: [] }), { status: 200 });
  });
  return {
    calls,
    fetch: fetchFn as unknown as typeof fetch,
    events: () => calls.filter((c) => c.url.endsWith("/v1/events/batch")).flatMap((c) => c.body.batch as WireEvent[]),
    deferredCalls: () => calls.filter((c) => c.url.endsWith("/v1/deep-links/deferred")),
  };
}

function page(href: string, referrer = "", cookie = "") {
  vi.stubGlobal("location", { href });
  vi.stubGlobal("document", { referrer, cookie });
}

function make(s: ReturnType<typeof server>, opts: Partial<ConstructorParameters<typeof LeanAppClient>[0]> = {}, clock = { t: T0 }) {
  let id = 0;
  return new LeanAppClient({
    apiKey: KEY,
    platform: "web",
    storage: memoryStorage(),
    flushAt: 1000,
    flushIntervalMs: 60_000,
    flushOnHide: false,
    now: () => clock.t,
    uuid: () => `id-${opts.platform ?? "web"}-${clock.t}-${++id}`,
    random: () => 0.5,
    fetch: s.fetch,
    ...opts,
  });
}

const named = (events: WireEvent[], name: string) => events.filter((e) => e.event_name === name);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web auto-capture", () => {
  it("captures UTMs, click ids, the landing page and an external referrer on start, and sends landing_viewed", async () => {
    page("https://shop.example/sale?utm_source=google&utm_medium=cpc&utm_campaign=ramadan&gclid=Cj0K&email=a%40b.com#top", "https://www.google.com/search?q=private");
    const s = server();
    const c = make(s);
    c.track("product_viewed");
    await c.flush();
    const events = s.events();
    expect(events.map((e) => e.event_name)).toEqual(["landing_viewed", "product_viewed"]);
    const landing = events[0];
    // Other query parameters (here an email) and the referrer's query never leave the browser.
    expect(landing.properties).toEqual({
      landing_url: "https://shop.example/sale?utm_source=google&utm_medium=cpc&utm_campaign=ramadan&gclid=Cj0K",
      referrer: "https://www.google.com/search",
    });
    expect(landing.context.attribution).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "ramadan",
      gclid: "Cj0K",
      landing_url: "https://shop.example/sale?utm_source=google&utm_medium=cpc&utm_campaign=ramadan&gclid=Cj0K",
      referrer: "https://www.google.com/search",
      touch: "first",
    });
    // Only the session's first event carries the touch; later events in the session don't repeat it.
    expect(events[1].context.attribution).toBeUndefined();
    expect(events[1].session_id).toBe(landing.session_id);
    expect(c.getAttribution()?.first.utm_source).toBe("google");
  });

  it("direct visit (missing UTMs, no referrer): no touch, no landing_viewed, only the landing page on the session's first event", async () => {
    page("https://shop.example/");
    const s = server();
    const c = make(s);
    c.track("a");
    c.track("b");
    await c.flush();
    const [a, b] = s.events();
    expect(named(s.events(), "landing_viewed")).toHaveLength(0);
    expect(a.context.attribution).toEqual({ landing_url: "https://shop.example/" });
    expect(b.context.attribution).toBeUndefined();
    expect(c.getAttribution()).toBeNull();
  });

  it("a later direct session never carries or overwrites the earlier paid source", async () => {
    const storage: StorageAdapter = memoryStorage();
    const clock = { t: T0 };
    page("https://shop.example/?utm_source=meta&utm_medium=paid_social&fbclid=IwAR1");
    const s = server();
    const first = make(s, { storage, metaBrowserIds: false }, clock);
    first.track("a");
    await first.flush();
    await first.shutdown();

    clock.t += 2 * 3_600_000; // a new session
    page("https://shop.example/pricing");
    const second = make(s, { storage, metaBrowserIds: false }, clock);
    second.track("signup_completed");
    await second.flush();
    const signup = named(s.events(), "signup_completed")[0];
    expect(signup.context.attribution).toEqual({ landing_url: "https://shop.example/pricing" });
    expect(named(s.events(), "landing_viewed")).toHaveLength(1);
    // The paid touch stays the first and the latest touch on the device.
    expect(second.getAttribution()).toMatchObject({ first: { utm_source: "meta" }, latest: { utm_source: "meta" } });
  });

  it("a new campaign in a later session becomes the latest touch and keeps the first", async () => {
    const storage = memoryStorage();
    const clock = { t: T0 };
    const s = server();
    page("https://shop.example/?utm_source=tiktok&ttclid=t1");
    const first = make(s, { storage }, clock);
    await first.flush();
    await first.shutdown();
    clock.t += 86_400_000;
    page("https://shop.example/?utm_source=newsletter&utm_medium=email");
    const second = make(s, { storage }, clock);
    second.track("order_completed");
    await second.flush();
    const landings = named(s.events(), "landing_viewed");
    expect(landings.map((e) => (e.context.attribution as Record<string, string> | undefined)?.touch)).toEqual(["first", "latest"]);
    expect(second.getAttribution()).toMatchObject({ first: { utm_source: "tiktok" }, latest: { utm_source: "newsletter" } });
    expect(named(s.events(), "order_completed")[0].context.attribution).toBeUndefined();
  });

  it("a referral (external referrer without UTMs) is a touch; internal and listed domains are not", async () => {
    page("https://shop.example/blog", "https://news.example.org/article?id=1");
    let s = server();
    let c = make(s);
    await c.flush();
    expect(named(s.events(), "landing_viewed")[0].context.attribution).toEqual({
      landing_url: "https://shop.example/blog",
      referrer: "https://news.example.org/article",
      touch: "first",
    });
    await c.shutdown();

    page("https://shop.example/cart", "https://www.shop.example/product");
    s = server();
    c = make(s);
    c.track("a");
    await c.flush();
    expect(named(s.events(), "landing_viewed")).toHaveLength(0);
    await c.shutdown();

    page("https://shop.example/thanks", "https://pay.checkout.example.net/done");
    s = server();
    c = make(s, { internalDomains: ["checkout.example.net"] });
    c.track("a");
    await c.flush();
    expect(named(s.events(), "landing_viewed")).toHaveLength(0);
  });

  it("capturing the same page again in the session (manual call after autoCapture) sends one landing_viewed", async () => {
    page("https://shop.example/?utm_source=snapchat&ScCid=s1");
    const s = server();
    const c = make(s);
    c.captureAttribution("https://shop.example/?utm_source=snapchat&ScCid=s1");
    await c.flush();
    expect(named(s.events(), "landing_viewed")).toHaveLength(1);
  });

  it("can be turned off", async () => {
    page("https://shop.example/?utm_source=google");
    const s = server();
    const c = make(s, { autoCapture: false });
    c.track("a");
    await c.flush();
    expect(named(s.events(), "landing_viewed")).toHaveLength(0);
    expect(c.getAttribution()).toBeNull();
  });
});

describe("Meta browser ids", () => {
  it("sends the browser's user agent as context.user_agent on web events", async () => {
    page("https://shop.example/");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" });
    const s = server();
    const c = make(s);
    c.track("a");
    await c.flush();
    expect(s.events()[0].context.user_agent).toBe("Mozilla/5.0 (iPhone) Safari/604.1");
  });

  it("only reads Meta's cookies, never sets them", async () => {
    page("https://shop.example/?fbclid=IwAR9", "", "");
    const s = server();
    const c = make(s);
    c.track("a");
    await c.flush();
    expect((globalThis as unknown as { document: { cookie: string } }).document.cookie).toBe("");
  });

  it("adds _fbp/_fbc cookie values to every event, and builds fbc from an observed fbclid when there is no _fbc cookie", async () => {
    page("https://shop.example/?fbclid=IwAR9", "", "_fbp=fb.1.1700000000000.42; other=1");
    const s = server();
    const c = make(s);
    c.track("a");
    await c.flush();
    const [landing, a] = s.events();
    expect(landing.context.attribution).toMatchObject({ fbclid: "IwAR9", fbp: "fb.1.1700000000000.42", fbc: `fb.1.${T0}.IwAR9` });
    expect(a.context.attribution).toEqual({ fbp: "fb.1.1700000000000.42", fbc: `fb.1.${T0}.IwAR9` });
  });

  it("prefers Meta's _fbc cookie, and sends neither without marketing consent", async () => {
    page("https://shop.example/?fbclid=IwAR9", "", "_fbp=fb.1.1.42; _fbc=fb.1.1690000000000.IwAR9");
    let s = server();
    let c = make(s);
    c.track("a");
    await c.flush();
    expect(named(s.events(), "a")[0].context.attribution).toEqual({ fbp: "fb.1.1.42", fbc: "fb.1.1690000000000.IwAR9" });
    await c.shutdown();

    s = server();
    c = make(s, { consentDefault: { marketing: "denied" } });
    c.track("a");
    await c.flush();
    const [landing, a] = s.events();
    expect(landing.context.attribution).not.toHaveProperty("fbp");
    expect(landing.context.attribution).not.toHaveProperty("fbc");
    expect(a.context.attribution).toBeUndefined();
  });

  it("adds TikTok's _ttp and Snap's _scid cookie values to every event with marketing consent, never setting them", async () => {
    const cookie = "_ttp=2Qx8mJf1nT0aBcDeFgHiJkLmNoP; _scid=0e8b4a2c-3f1d-4c55-9a77-1b2c3d4e5f60; other=1";
    page("https://shop.example/?ttclid=E.C.P.abc", "", cookie);
    const s = server();
    const c = make(s);
    c.track("a");
    await c.flush();
    const [landing, a] = s.events();
    expect(landing.context.attribution).toMatchObject({ ttclid: "E.C.P.abc", ttp: "2Qx8mJf1nT0aBcDeFgHiJkLmNoP", scid: "0e8b4a2c-3f1d-4c55-9a77-1b2c3d4e5f60" });
    expect(a.context.attribution).toEqual({ ttp: "2Qx8mJf1nT0aBcDeFgHiJkLmNoP", scid: "0e8b4a2c-3f1d-4c55-9a77-1b2c3d4e5f60" });
    expect((globalThis as unknown as { document: { cookie: string } }).document.cookie).toBe(cookie);
  });

  it("sends neither _ttp nor _scid without marketing consent, or when turned off", async () => {
    page("https://shop.example/?ttclid=E.C.P.abc", "", "_ttp=2Qx8mJf1nT0aBcDeFgHiJkLmNoP; _scid=0e8b4a2c-3f1d-4c55");
    let s = server();
    let c = make(s, { consentDefault: { marketing: "denied" } });
    c.track("a");
    await c.flush();
    for (const e of s.events()) {
      expect(e.context.attribution ?? {}).not.toHaveProperty("ttp");
      expect(e.context.attribution ?? {}).not.toHaveProperty("scid");
    }
    await c.shutdown();

    s = server();
    c = make(s, { tiktokBrowserId: false });
    c.track("a");
    await c.flush();
    expect(named(s.events(), "a")[0].context.attribution).toEqual({ scid: "0e8b4a2c-3f1d-4c55" });
    await c.shutdown();

    s = server();
    c = make(s, { snapBrowserId: false, tiktokBrowserId: false });
    c.track("a");
    await c.flush();
    expect(named(s.events(), "a")[0].context.attribution).toBeUndefined();
  });
});

describe("web attribution and consent", () => {
  it("holds landing_viewed with its touch until consent; analytics alone releases it without attribution", async () => {
    page("https://shop.example/?utm_source=google&gclid=g1");
    const s = server();
    const c = make(s, { consentDefault: "pending" });
    c.track("a");
    await c.flush();
    expect(s.events()).toHaveLength(0);
    c.setConsent({ analytics: true });
    await c.flush();
    const sent = s.events().filter((e) => e.type === "track");
    expect(sent.map((e) => e.event_name)).toEqual(["landing_viewed", "a"]);
    for (const e of sent) expect(e.context.attribution).toBeUndefined();
    expect(c.getAttribution()).toBeNull();
  });

  it("releases the held touch with landing_viewed when attribution consent is granted too", async () => {
    page("https://shop.example/?utm_source=google&gclid=g1");
    const s = server();
    const c = make(s, { consentDefault: "pending", metaBrowserIds: false });
    c.track("a");
    c.setConsent({ analytics: true, attribution: true });
    await c.flush();
    const landing = named(s.events(), "landing_viewed")[0];
    expect(landing.context.attribution).toMatchObject({ utm_source: "google", gclid: "g1", touch: "first" });
    expect(landing.context.consent).toBeUndefined(); // queued before the answer
    c.track("b");
    await c.flush();
    expect(named(s.events(), "b")[0].context.consent).toEqual({ analytics: true, attribution: true });
    expect(c.getAttribution()?.first.utm_source).toBe("google");
  });

  it("attribution denied: nothing is stored or attached", async () => {
    page("https://shop.example/?utm_source=google");
    const s = server();
    const c = make(s, { consentDefault: { attribution: "denied" } });
    c.track("a");
    await c.flush();
    expect(named(s.events(), "landing_viewed")).toHaveLength(0);
    expect(s.events()[0].context.attribution).toBeUndefined();
    expect(c.getAttribution()).toBeNull();
  });
});

describe("deferred deep links (React Native)", () => {
  const match: DeferredDeepLink = {
    match_type: "deterministic",
    match_key: "click_id",
    link: { code: "abcd1234", name: "Ramadan" },
    deep_link: { path: "/product/42", params: {}, url: "/product/42" },
    click_id: "lac_abcdefgh12",
    is_deferred: true,
  };

  it("asks once per new install on first launch and hands the answer to the app", async () => {
    const storage = memoryStorage();
    const s = server(() => ({ status: 200, body: match }));
    const seen: DeferredDeepLink[] = [];
    const first = make(s, { platform: "react_native", storage, context: { os: "android", os_version: "14" }, onDeferredDeepLink: (r) => seen.push(r) });
    expect(await first.getDeferredDeepLink()).toEqual(match);
    expect(seen).toEqual([match]);
    expect(s.deferredCalls()).toHaveLength(1);
    expect(s.deferredCalls()[0].body).toEqual({ anonymous_id: first.getAnonymousId(), platform: "react_native", os: "android", os_version: "14" });
    await first.shutdown();

    const second = make(s, { platform: "react_native", storage });
    expect(await second.getDeferredDeepLink()).toBeNull();
    second.reset();
    await second.flush();
    expect(s.deferredCalls()).toHaveLength(1);
  });

  it("never asks for installs that already used the SDK before deferred links existed", async () => {
    const storage = memoryStorage();
    await storage.setItem("leanapp:la_pk_dev:state", JSON.stringify({ anonymousId: "existing" }));
    const s = server();
    const c = make(s, { platform: "react_native", storage });
    expect(await c.getDeferredDeepLink()).toBeNull();
    expect(s.deferredCalls()).toHaveLength(0);
  });

  it("waits for attribution consent, and asks again on the next launch after a failure", async () => {
    const storage = memoryStorage();
    const s = server((n) => (n === 1 ? { status: 503 } : { status: 200, body: match }));
    const first = make(s, { platform: "react_native", storage, consentDefault: { attribution: "pending" } });
    await first.whenReady();
    expect(s.deferredCalls()).toHaveLength(0);
    first.setConsent({ attribution: true });
    expect(await first.getDeferredDeepLink()).toBeNull(); // 503
    expect(s.deferredCalls()).toHaveLength(1);
    await first.shutdown();

    const second = make(s, { platform: "react_native", storage });
    // The first launch never got an answer, so the next launch asks again; then never again.
    expect(await second.getDeferredDeepLink()).toEqual(match);
    expect(s.deferredCalls()).toHaveLength(2);
    await second.shutdown();
    const third = make(s, { platform: "react_native", storage });
    expect(await third.getDeferredDeepLink()).toBeNull();
    expect(s.deferredCalls()).toHaveLength(2);
  });

  it("is off on the web and when turned off", async () => {
    vi.stubGlobal("location", undefined);
    const s = server();
    const web = make(s);
    expect(await web.getDeferredDeepLink()).toBeNull();
    const off = make(s, { platform: "react_native", deferredDeepLinks: false });
    expect(await off.getDeferredDeepLink()).toBeNull();
    expect(s.deferredCalls()).toHaveLength(0);
  });
});

describe("attribution parsing", () => {
  it("reads utm_id and campaign ids next to a source, but never treats campaign ids alone as attribution", () => {
    expect(parseAttribution("https://x.test/?utm_source=meta&utm_id=120&campaign_id=c1&adset_id=s1&ad_id=a1")).toEqual({
      utm_source: "meta",
      utm_id: "120",
      campaign_id: "c1",
      adset_id: "s1",
      ad_id: "a1",
    });
    expect(parseAttribution("https://classifieds.test/item?ad_id=99")).toBeNull();
  });

  it("webTouch gives null when the visit shows no source", () => {
    expect(webTouch("https://shop.example/?ad_id=1", "")).toBeNull();
    expect(webTouch("https://shop.example/", "https://shop.example/a")).toBeNull();
    expect(webTouch("not a url", "")).toBeNull();
  });
});
