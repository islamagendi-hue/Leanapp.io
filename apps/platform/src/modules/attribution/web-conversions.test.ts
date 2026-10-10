/**
 * TikTok Events API 2.0 and Snap Conversions API v3 website events: request
 * shape, hashing, eligibility and validation. Pure; no provider is called.
 */
import { describe, expect, it } from "vitest";
import { actionSourceOf, eligibility, pixelCookieId, requestSummary, sha256Hex, snapUserData, tiktokUserData, validateConversionBody } from "./conversions";
import { buildRequest, configProblem, NETWORK_SPECS, networkEventName } from "./networks";

const now = 1_790_000_000;
const noId = { anonymousId: null, userId: null };
const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const payload = { event: "purchase_completed", event_id: "conversion:9", revenue: 75, currency: "SAR", timestamp: now - 30, platform: "web" };
const web = { eventId: "evt-web-1", eventSourceUrl: "https://shop.example/thanks", userAgent: ua, ttp: "2Qx8mJf1nT0aBcDeFgHiJkLmNoP", scid: "0e8b4a2c-3f1d-4c55-9a77-1b2c3d4e5f60" };
const user = { email: " Jane.Doe@Example.com ", phone: "+966 50 123 4567", externalId: "u-42" };
const body = (r: ReturnType<typeof buildRequest>) => {
  if (!r.ok) throw new Error(r.error);
  return JSON.parse(r.request.body!);
};

describe("action source setting", () => {
  it("is shared by Meta, TikTok and Snap: app by default, website, or by platform", () => {
    expect(actionSourceOf(undefined, "web")).toBe("app");
    expect(actionSourceOf("website", "android")).toBe("website");
    expect(actionSourceOf("auto", "web")).toBe("website");
    expect(actionSourceOf("auto", "ios")).toBe("app");
    for (const n of ["tiktok", "snapchat"] as const) {
      const f = NETWORK_SPECS[n].config.find((c) => c.key === "action_source")!;
      expect(f.options!.map((o) => o.value)).toEqual(["app", "website", "auto"]);
      expect(NETWORK_SPECS[n].config.find((c) => c.key === "send_user_data")!.options![0].value).toBe("off");
    }
  });

  it("requires the app id for app events and the pixel id for website events", () => {
    expect(configProblem("tiktok", { tiktok_app_id: "7001" })).toBeNull();
    expect(configProblem("tiktok", {})).toMatch(/App ID/);
    expect(configProblem("tiktok", { action_source: "website", tiktok_pixel_code: "C123" })).toBeNull();
    expect(configProblem("tiktok", { action_source: "website", tiktok_app_id: "7001" })).toMatch(/Pixel code/);
    expect(configProblem("tiktok", { action_source: "auto", tiktok_pixel_code: "C123" })).toMatch(/App ID/);
    expect(configProblem("tiktok", { action_source: "auto", tiktok_pixel_code: "C123", tiktok_app_id: "7001" })).toBeNull();
    expect(configProblem("snapchat", { action_source: "website", snap_pixel_id: "px-1" })).toBeNull();
    expect(configProblem("snapchat", { action_source: "website" })).toMatch(/Pixel ID/);
    expect(configProblem("snapchat", { snap_app_id: "s" })).toBeNull();
    expect(configProblem("meta", {})).toBeNull();
  });
});

describe("web event names", () => {
  it("maps purchases, sign-ups and views to the networks' website events", () => {
    expect(networkEventName("tiktok", payload, undefined, "website")).toBe("CompletePayment");
    expect(networkEventName("tiktok", { event: "signup_completed" }, undefined, "website")).toBe("CompleteRegistration");
    expect(networkEventName("tiktok", { event: "product_viewed" }, undefined, "website")).toBe("ViewContent");
    expect(networkEventName("snapchat", payload, undefined, "website")).toBe("PURCHASE");
    expect(networkEventName("snapchat", { event: "signup_completed" }, undefined, "website")).toBe("SIGN_UP");
    expect(networkEventName("snapchat", { event: "view_content" }, undefined, "website")).toBe("VIEW_CONTENT");
    // App names unchanged; the event map still wins.
    expect(networkEventName("tiktok", payload)).toBe("Purchase");
    expect(networkEventName("tiktok", payload, { purchase_completed: "PlaceAnOrder" }, "website")).toBe("PlaceAnOrder");
    expect(networkEventName("snapchat", { event: "install" }, undefined, "website")).toBe("APP_INSTALL");
  });
});

describe("hashed user data", () => {
  it("hashes TikTok email, E.164 phone and external_id as single SHA-256 strings", () => {
    expect(tiktokUserData(user)).toEqual({ email: sha256Hex("jane.doe@example.com"), phone: sha256Hex("+966501234567"), external_id: sha256Hex("u-42") });
    expect(tiktokUserData({ email: "nope", phone: "0501234567" })).toEqual({});
  });

  it("hashes Snap em / ph / external_id as arrays, phone digits with country code", () => {
    expect(snapUserData(user)).toEqual({ em: [sha256Hex("jane.doe@example.com")], ph: [sha256Hex("966501234567")], external_id: [sha256Hex("u-42")] });
  });

  it("accepts pixel cookie ids only in an opaque-id shape", () => {
    expect(pixelCookieId(web.ttp)).toBe(web.ttp);
    expect(pixelCookieId(` ${web.scid} `)).toBe(web.scid);
    expect(pixelCookieId("short")).toBeNull();
    expect(pixelCookieId("has space inside it")).toBeNull();
    expect(pixelCookieId("<script>alert(1)</script>")).toBeNull();
    expect(pixelCookieId(42)).toBeNull();
  });
});

describe("TikTok Events API 2.0 website events", () => {
  const config = { tiktok_pixel_code: "CPIXEL123", action_source: "website", test_event_code: "TEST123" };

  it("sends event_source web with the pixel code, page URL, user agent, ttclid, _ttp and hashed user data", () => {
    const r = buildRequest("tiktok", { config, credentials: { access_token: "TT-SECRET" }, payload: { ...payload, network_click_param: "ttclid", network_click_id: "E.C.P.abc" }, web, userData: user });
    expect(r.ok && r.request).toMatchObject({ url: "https://business-api.tiktok.com/open_api/v1.3/event/track/", method: "POST", headers: { "Access-Token": "TT-SECRET" } });
    const b = body(r);
    expect(b).toMatchObject({ event_source: "web", event_source_id: "CPIXEL123", test_event_code: "TEST123" });
    expect(b.data[0]).toEqual({
      event: "CompletePayment", event_time: now - 30, event_id: "evt-web-1",
      user: { ttclid: "E.C.P.abc", ttp: web.ttp, email: sha256Hex("jane.doe@example.com"), phone: sha256Hex("+966501234567"), external_id: sha256Hex("u-42"), user_agent: ua },
      page: { url: "https://shop.example/thanks" },
      properties: { value: 75, currency: "SAR" },
    });
    expect(r.ok && r.request.body).not.toContain("Jane");
    expect(validateConversionBody("tiktok", r.ok ? r.request.body : "", now)).toBeNull();
    // The log keeps the source and the names of the match keys, never their values or the token.
    const summary = requestSummary(r.ok ? r.request : { url: "", method: "POST", headers: {} });
    expect(summary).toEqual({ method: "POST", endpoint: "business-api.tiktok.com/open_api/v1.3/event/track/", test_event: true,
      events: [{ name: "CompletePayment", event_id: "evt-web-1", action_source: "web", match_keys: ["email", "external_id", "phone", "ttclid", "ttp", "user_agent"] }] });
    expect(JSON.stringify(summary)).not.toContain(ua);
  });

  it("keeps app events as before, and picks by platform with auto", () => {
    const app = body(buildRequest("tiktok", { config: { tiktok_app_id: "7001" }, credentials: { access_token: "t" }, payload: { ...payload, platform: "android", network_click_param: "ttclid", network_click_id: "x" }, web, userData: user }));
    expect(app).toMatchObject({ event_source: "app", event_source_id: "7001" });
    expect(app.data[0]).toEqual({ event: "Purchase", event_time: now - 30, event_id: "conversion:9", user: { ttclid: "x" }, properties: { value: 75, currency: "SAR" } });
    const auto = { tiktok_app_id: "7001", tiktok_pixel_code: "CP", action_source: "auto" };
    expect(body(buildRequest("tiktok", { config: auto, credentials: { access_token: "t" }, payload, web })).event_source).toBe("web");
    expect(body(buildRequest("tiktok", { config: auto, credentials: { access_token: "t" }, payload: { ...payload, platform: "ios" } })).event_source).toBe("app");
  });

  it("refuses website events without the pixel code, and fails validation without the page URL, user agent or match key", () => {
    expect(buildRequest("tiktok", { config: { action_source: "website", tiktok_app_id: "7001" }, credentials: { access_token: "t" }, payload, web })).toMatchObject({ ok: false });
    const noUa = buildRequest("tiktok", { config, credentials: { access_token: "t" }, payload, web: { ...web, userAgent: null } });
    expect(validateConversionBody("tiktok", noUa.ok ? noUa.request.body : "", now)).toMatch(/user_agent/);
    const noUrl = buildRequest("tiktok", { config, credentials: { access_token: "t" }, payload, web: { ...web, eventSourceUrl: null } });
    expect(validateConversionBody("tiktok", noUrl.ok ? noUrl.request.body : "", now)).toMatch(/page\.url/);
    const noKey = buildRequest("tiktok", { config, credentials: { access_token: "t" }, payload, web: { ...web, ttp: null } });
    expect(validateConversionBody("tiktok", noKey.ok ? noKey.request.body : "", now)).toMatch(/no match key/);
    const install = buildRequest("tiktok", { config, credentials: { access_token: "t" }, payload: { ...payload, event: "install", revenue: null }, web });
    expect(validateConversionBody("tiktok", install.ok ? install.request.body : "", now)).toMatch(/installs/);
    const badHash = JSON.stringify({ event_source: "web", event_source_id: "CP", data: [{ event: "CompletePayment", event_id: "e", event_time: now, page: { url: "https://a.example/" }, user: { user_agent: ua, email: "jane@example.com" } }] });
    expect(validateConversionBody("tiktok", badHash, now)).toMatch(/SHA-256/);
  });

  it("drops a malformed _ttp cookie rather than sending it", () => {
    const b = body(buildRequest("tiktok", { config, credentials: { access_token: "t" }, payload: { ...payload, network_click_param: "ttclid", network_click_id: "c" }, web: { ...web, ttp: "bad value; x" } }));
    expect(b.data[0].user.ttp).toBeUndefined();
  });
});

describe("Snap Conversions API v3 website events", () => {
  const config = { snap_pixel_id: "pixel-uuid-1", action_source: "website" };

  it("sends action_source WEB to the pixel's endpoint with the page URL, user agent, ScCid, _scid and hashed user data", () => {
    const r = buildRequest("snapchat", { config, credentials: { access_token: "SNAP-SECRET" }, payload: { ...payload, network_click_param: "ScCid", network_click_id: "sc-1" }, web, userData: user });
    expect(r.ok && r.request.url).toBe("https://tr.snapchat.com/v3/pixel-uuid-1/events?access_token=SNAP-SECRET");
    const b = body(r);
    expect(b.data[0]).toEqual({
      event_name: "PURCHASE", event_time: now - 30, event_id: "evt-web-1", action_source: "WEB", event_source_url: "https://shop.example/thanks",
      user_data: { client_user_agent: ua, sc_click_id: "sc-1", sc_cookie1: web.scid, em: [sha256Hex("jane.doe@example.com")], ph: [sha256Hex("966501234567")], external_id: [sha256Hex("u-42")] },
      custom_data: { value: 75, currency: "SAR" },
    });
    expect(validateConversionBody("snapchat", r.ok ? r.request.body : "", now)).toBeNull();
    const summary = requestSummary(r.ok ? r.request : { url: "", method: "POST", headers: {} });
    expect(summary.endpoint).toBe("tr.snapchat.com/v3/pixel-uuid-1/events");
    expect(JSON.stringify(summary)).not.toContain("SNAP-SECRET");
    expect(summary.events).toEqual([{ name: "PURCHASE", event_id: "evt-web-1", action_source: "WEB", match_keys: ["client_user_agent", "em", "external_id", "ph", "sc_click_id", "sc_cookie1"] }]);
  });

  it("sends app events to the Snap App ID as MOBILE_APP, without web fields or user data", () => {
    const r = buildRequest("snapchat", { config: { snap_app_id: "app-1", snap_pixel_id: "px", action_source: "auto" }, credentials: { access_token: "t" }, payload: { ...payload, platform: "android", network_click_param: "ScCid", network_click_id: "sc" }, web, userData: user });
    expect(r.ok && r.request.url).toContain("/v3/app-1/events");
    expect(body(r).data[0]).toEqual({ event_name: "PURCHASE", event_time: now - 30, event_id: "conversion:9", action_source: "MOBILE_APP", user_data: { sc_click_id: "sc" }, custom_data: { value: 75, currency: "SAR" } });
  });

  it("fails validation without the page URL, user agent or any match key, and for installs", () => {
    const noUa = buildRequest("snapchat", { config, credentials: { access_token: "t" }, payload, web: { ...web, userAgent: null } });
    expect(validateConversionBody("snapchat", noUa.ok ? noUa.request.body : "", now)).toMatch(/client_user_agent/);
    const noUrl = buildRequest("snapchat", { config, credentials: { access_token: "t" }, payload, web: { ...web, eventSourceUrl: null } });
    expect(validateConversionBody("snapchat", noUrl.ok ? noUrl.request.body : "", now)).toMatch(/event_source_url/);
    const noKey = buildRequest("snapchat", { config, credentials: { access_token: "t" }, payload, web: { ...web, scid: null } });
    expect(validateConversionBody("snapchat", noKey.ok ? noKey.request.body : "", now)).toMatch(/no match key/);
    const install = buildRequest("snapchat", { config, credentials: { access_token: "t" }, payload: { ...payload, event: "install", revenue: null }, web });
    expect(validateConversionBody("snapchat", install.ok ? install.request.body : "", now)).toMatch(/installs/);
  });
});

describe("eligibility of website events", () => {
  it("needs a click id, the pixel cookie or hashed user data", () => {
    const site = { actionSource: "website" as const };
    expect(eligibility("tiktok", {}, noId, null, site)).toBe("no_match_key");
    expect(eligibility("tiktok", {}, noId, null, { ...site, browserIds: true })).toBeNull();
    expect(eligibility("tiktok", {}, noId, null, { ...site, userData: true })).toBeNull();
    expect(eligibility("tiktok", { network_click_param: "ttclid", network_click_id: "t" }, noId, null, site)).toBeNull();
    expect(eligibility("snapchat", {}, noId, null, site)).toBe("no_match_key");
    expect(eligibility("snapchat", {}, noId, null, { ...site, browserIds: true })).toBeNull();
    expect(eligibility("snapchat", { network_click_param: "ScCid", network_click_id: "s" }, noId, null, site)).toBeNull();
    // App events unchanged: Snap needs ScCid, TikTok is sent as before.
    expect(eligibility("snapchat", {}, noId, null, { actionSource: "app", browserIds: true })).toBe("no_match_key");
    expect(eligibility("tiktok", {}, noId, null, { actionSource: "app" })).toBeNull();
    expect(eligibility("tiktok", { network_click_param: "ttclid", network_click_id: "t" }, noId, false, site)).toBe("consent_denied");
  });
});
