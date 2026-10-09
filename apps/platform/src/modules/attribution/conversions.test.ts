import { describe, expect, it } from "vitest";
import {
  eligibility, googleUserIdentifiers, metaActionSource, metaUserData, normalizeEmail, normalizePhone, parseProviderError, requestSummary, sha256Hex,
  userDataAllowed, userDataMode, validateConversionBody,
} from "./conversions";
import { buildRequest } from "./networks";

const now = 1_790_000_000;
const noId = { anonymousId: null, userId: null };

describe("conversion eligibility", () => {
  it("skips denied consent, and events the network can't match", () => {
    expect(eligibility("meta", { network_click_param: "fbclid", network_click_id: "x" }, noId, false)).toBe("consent_denied");
    expect(eligibility("meta", {}, noId, null)).toBe("no_match_key");
    expect(eligibility("meta", {}, { anonymousId: "a1", userId: null }, null)).toBeNull();
    expect(eligibility("snapchat", {}, { anonymousId: "a1", userId: null }, true)).toBe("no_match_key");
    expect(eligibility("snapchat", { network_click_param: "ScCid", network_click_id: "s" }, noId, null)).toBeNull();
    expect(eligibility("tiktok", {}, noId, null)).toBeNull();
  });
});

describe("Meta / Snap request validation", () => {
  const metaBody = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ data: [{ event_name: "Purchase", event_time: now - 60, event_id: "conversion:1", action_source: "app", user_data: { anon_id: "a1" }, app_data: { advertiser_tracking_enabled: 0, extinfo: ["a2"] }, custom_data: { value: 10, currency: "SAR" }, ...o }] });

  it("accepts a well-formed event and rejects broken ones", () => {
    expect(validateConversionBody("meta", metaBody(), now)).toBeNull();
    expect(validateConversionBody("meta", metaBody({ event_id: undefined }), now)).toMatch(/event_id/);
    expect(validateConversionBody("meta", metaBody({ event_time: now - 8 * 86400 }), now)).toMatch(/older than 7 days/);
    expect(validateConversionBody("meta", metaBody({ event_time: now + 3600 }), now)).toMatch(/future/);
    expect(validateConversionBody("meta", metaBody({ custom_data: { value: 5, currency: "riyal" } }), now)).toMatch(/currency/);
    expect(validateConversionBody("meta", metaBody({ user_data: {} }), now)).toMatch(/match key/);
    expect(validateConversionBody("meta", metaBody({ app_data: undefined }), now)).toMatch(/app_data/);
    expect(validateConversionBody("snapchat", "not json", now)).toMatch(/JSON/);
    expect(validateConversionBody("custom", undefined, now)).toBeNull();
  });

  it("built requests pass validation, carry the event id and the install id for Meta", () => {
    const payload = { event: "purchase_completed", event_id: "conversion:42", revenue: "25", currency: "SAR", timestamp: now - 10, platform: "android" };
    const meta = buildRequest("meta", { config: { dataset_id: "99" }, credentials: { access_token: "SECRET" }, payload, anonymousId: "anon-7" });
    if (!meta.ok) throw new Error(meta.error);
    expect(validateConversionBody("meta", meta.request.body, now)).toBeNull();
    expect(JSON.parse(meta.request.body!).data[0]).toMatchObject({ event_id: "conversion:42", user_data: { anon_id: "anon-7" } });
    const snap = buildRequest("snapchat", { config: { snap_app_id: "app" }, credentials: { access_token: "SECRET" }, payload: { ...payload, network_click_param: "ScCid", network_click_id: "sc1" } });
    if (!snap.ok) throw new Error(snap.error);
    expect(validateConversionBody("snapchat", snap.request.body, now)).toBeNull();
    // The delivery log never holds the token (Meta and Snap take it in the query).
    const summary = requestSummary(meta.request);
    expect(JSON.stringify(summary)).not.toContain("SECRET");
    expect(summary).toMatchObject({ endpoint: "graph.facebook.com/v21.0/99/events", events: [{ name: "Purchase", event_id: "conversion:42" }] });
  });
});

describe("provider errors", () => {
  it("reads Meta's code, subcode and trace id and knows its throttling codes", () => {
    const e = parseProviderError("meta", 400, JSON.stringify({ error: { message: "Invalid parameter", code: 100, error_subcode: 2804003, fbtrace_id: "AbC" } }));
    expect(e).toEqual({ code: "100/2804003", traceId: "AbC", message: "Invalid parameter", retryable: false });
    expect(parseProviderError("meta", 400, JSON.stringify({ error: { code: 17, message: "limit" } })).retryable).toBe(true);
  });

  it("reads Snap, TikTok and Google formats and falls back to the text", () => {
    expect(parseProviderError("snapchat", 400, JSON.stringify({ status: "INVALID", reason: "bad event", request_id: "r1" }))).toMatchObject({ code: "INVALID", traceId: "r1", message: "bad event" });
    expect(parseProviderError("tiktok", 200, JSON.stringify({ code: 40100, message: "busy", request_id: "q" }))).toMatchObject({ code: "40100", retryable: true });
    expect(parseProviderError("google", 429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }))).toMatchObject({ retryable: true });
    expect(parseProviderError("custom", 500, "oops")).toMatchObject({ message: "oops", code: null });
  });
});

describe("Meta website events (Pixel + Conversions API)", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const payload = { event: "purchase_completed", event_id: "conversion:7", revenue: 49, currency: "SAR", timestamp: now - 30, platform: "web" };
  const web = { eventId: "evt-browser-1", eventSourceUrl: "https://shop.example/checkout/done", userAgent: ua, fbp: "fb.1.1790000000000.1234567890", fbc: null };

  it("picks the action source per postback setting", () => {
    expect(metaActionSource(undefined, "web")).toBe("app");
    expect(metaActionSource("website", "ios")).toBe("website");
    expect(metaActionSource("auto", "web")).toBe("website");
    expect(metaActionSource("auto", "android")).toBe("app");
  });

  it("sends action_source website with the page URL, user agent, fbp / fbc and the browser event id", () => {
    const r = buildRequest("meta", { config: { dataset_id: "PIXEL1", action_source: "website" }, credentials: { access_token: "SECRET" }, payload: { ...payload, network_click_param: "fbclid", network_click_id: "IwAR1" }, anonymousId: "anon-1", web });
    if (!r.ok) throw new Error(r.error);
    const e = JSON.parse(r.request.body!).data[0];
    expect(e).toMatchObject({
      event_name: "Purchase", action_source: "website", event_id: "evt-browser-1", event_source_url: "https://shop.example/checkout/done",
      user_data: { client_user_agent: ua, fbp: "fb.1.1790000000000.1234567890", fbc: `fb.1.${(now - 30) * 1000}.IwAR1` },
      custom_data: { value: 49, currency: "SAR" },
    });
    // App-only fields never go out with a website event.
    expect(e.app_data).toBeUndefined();
    expect(e.user_data.anon_id).toBeUndefined();
    expect(validateConversionBody("meta", r.request.body, now)).toBeNull();
    expect(requestSummary(r.request)).toMatchObject({ events: [{ action_source: "website", match_keys: ["client_user_agent", "fbc", "fbp"] }] });
  });

  it("prefers the _fbc cookie over one rebuilt from the click id, and drops malformed browser ids", () => {
    const r = buildRequest("meta", { config: { dataset_id: "P", action_source: "website" }, credentials: { access_token: "S" }, payload: { ...payload, network_click_param: "fbclid", network_click_id: "IwAR1" }, web: { ...web, fbc: "fb.1.1789999999000.IwARcookie", fbp: "not-an-fbp" } });
    if (!r.ok) throw new Error(r.error);
    const ud = JSON.parse(r.request.body!).data[0].user_data;
    expect(ud.fbc).toBe("fb.1.1789999999000.IwARcookie");
    expect(ud.fbp).toBeUndefined();
  });

  it("rejects website events Meta would refuse", () => {
    const body = (o: Record<string, unknown>) => JSON.stringify({ data: [{ event_name: "Purchase", event_time: now - 5, event_id: "e1", action_source: "website", event_source_url: "https://a.example/", user_data: { client_user_agent: ua, fbp: "fb.1.1790000000000.1" }, ...o }] });
    expect(validateConversionBody("meta", body({}), now)).toBeNull();
    expect(validateConversionBody("meta", body({ event_source_url: undefined }), now)).toMatch(/event_source_url/);
    expect(validateConversionBody("meta", body({ user_data: { fbp: "fb.1.1790000000000.1" } }), now)).toMatch(/client_user_agent/);
    expect(validateConversionBody("meta", body({ user_data: { client_user_agent: ua } }), now)).toMatch(/match key/);
    expect(validateConversionBody("meta", body({ event_name: "MobileAppInstall" }), now)).toMatch(/installs/);
    expect(validateConversionBody("meta", body({ app_data: { extinfo: [] } }), now)).toMatch(/app_data/);
    expect(validateConversionBody("meta", body({ user_data: { client_user_agent: ua, em: ["someone@example.com"] } }), now)).toMatch(/SHA-256/);
  });

  it("needs a browser id, an fbclid or user data to be eligible", () => {
    const id = { anonymousId: "anon", userId: null };
    expect(eligibility("meta", {}, id, null, { actionSource: "website" })).toBe("no_match_key");
    expect(eligibility("meta", {}, id, null, { actionSource: "website", browserIds: true })).toBeNull();
    expect(eligibility("meta", {}, id, null, { actionSource: "website", userData: true })).toBeNull();
    expect(eligibility("meta", { network_click_param: "fbclid", network_click_id: "x" }, id, null, { actionSource: "website" })).toBeNull();
    // App events still match on the install id.
    expect(eligibility("meta", {}, id, null, { actionSource: "app" })).toBeNull();
  });

  it("adds a Meta test_event_code only when one is set, and says so in the log summary", () => {
    const r = buildRequest("meta", { config: { dataset_id: "P", test_event_code: "TEST123" }, credentials: { access_token: "S" }, payload: { ...payload, platform: "android" }, anonymousId: "a" });
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.request.body!).test_event_code).toBe("TEST123");
    expect(requestSummary(r.request).test_event).toBe(true);
  });
});

describe("hashed user data", () => {
  const sha = (v: string) => sha256Hex(v);

  it("normalises before hashing: Meta and Google differ on gmail dots and the phone plus sign", () => {
    expect(normalizeEmail("  Jane.Doe@GMAIL.com ", "meta")).toBe("jane.doe@gmail.com");
    expect(normalizeEmail("Jane.Doe@gmail.com", "google")).toBe("janedoe@gmail.com");
    expect(normalizeEmail("jane.doe@example.com", "google")).toBe("jane.doe@example.com");
    expect(normalizeEmail("not an email", "meta")).toBeNull();
    expect(normalizePhone("+966 50 123 4567", "meta")).toBe("966501234567");
    expect(normalizePhone("00966501234567", "google")).toBe("+966501234567");
    // No country code: dropped, never guessed.
    expect(normalizePhone("0501234567", "google")).toBeNull();
  });

  it("builds Meta em / ph / external_id and Google userIdentifiers as SHA-256 hex", () => {
    const raw = { email: "Jane@Example.com", phone: "+966501234567", externalId: "user-42" };
    expect(metaUserData(raw)).toEqual({ em: [sha("jane@example.com")], ph: [sha("966501234567")], external_id: [sha("user-42")] });
    expect(googleUserIdentifiers(raw)).toEqual([
      { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("jane@example.com") },
      { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha("+966501234567") },
    ]);
    expect(metaUserData({})).toEqual({});
  });

  it("is off by default and follows the user's attribution consent", () => {
    expect(userDataMode(undefined)).toBe("off");
    expect(userDataMode("bogus")).toBe("off");
    expect(userDataAllowed("off", true)).toBe(false);
    expect(userDataAllowed("with_consent", null)).toBe(false);
    expect(userDataAllowed("with_consent", true)).toBe(true);
    expect(userDataAllowed("unless_denied", null)).toBe(true);
    expect(userDataAllowed("unless_denied", false)).toBe(false);
  });

  it("puts hashed user data in a Meta app event, never the plain values", () => {
    const r = buildRequest("meta", { config: { dataset_id: "9" }, credentials: { access_token: "S" }, payload: { event: "signup", event_id: "conversion:1", timestamp: now - 1, platform: "ios" }, anonymousId: "a", userData: { email: "jane@example.com", externalId: "u1" } });
    if (!r.ok) throw new Error(r.error);
    expect(r.request.body).not.toContain("jane@example.com");
    expect(JSON.parse(r.request.body!).data[0].user_data).toMatchObject({ anon_id: "a", em: [sha("jane@example.com")], external_id: [sha("u1")] });
    expect(validateConversionBody("meta", r.request.body, now)).toBeNull();
  });
});

describe("Google Enhanced Conversions", () => {
  const base = { config: { customer_id: "123-456-7890", conversion_action_id: "55" }, credentials: { developer_token: "DEV" }, accessToken: "AT" };
  const payload = { event: "purchase_completed", event_id: "conversion:9", revenue: 10, currency: "USD", timestamp: now - 60 };

  it("adds user identifiers to a gclid conversion, and consent only when explicitly granted", () => {
    const r = buildRequest("google", { ...base, payload: { ...payload, network_click_param: "gclid", network_click_id: "G1" }, userData: { email: "a@example.com" } });
    if (!r.ok) throw new Error(r.error);
    const c = JSON.parse(r.request.body!).conversions[0];
    expect(c).toMatchObject({ gclid: "G1", orderId: "conversion:9", userIdentifiers: [{ hashedEmail: sha256Hex("a@example.com") }] });
    expect(c.consent).toBeUndefined();
    const granted = buildRequest("google", { ...base, payload: { ...payload, network_click_param: "gclid", network_click_id: "G1" }, userData: { email: "a@example.com" }, consentGranted: true });
    if (!granted.ok) throw new Error(granted.error);
    expect(JSON.parse(granted.request.body!).conversions[0].consent).toEqual({ adUserData: "GRANTED" });
    expect(requestSummary(r.request)).toMatchObject({ events: [{ order_id: "conversion:9", user_identifiers: 1 }] });
  });

  it("uploads without a click id when it has user identifiers, never with gbraid / wbraid", () => {
    const leads = buildRequest("google", { ...base, payload, userData: { phone: "+15551234567" } });
    if (!leads.ok) throw new Error(leads.error);
    const c = JSON.parse(leads.request.body!).conversions[0];
    expect(c.gclid).toBeUndefined();
    expect(c.userIdentifiers).toEqual([{ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha256Hex("+15551234567") }]);
    const braid = buildRequest("google", { ...base, payload: { ...payload, network_click_param: "gbraid", network_click_id: "B1" }, userData: { email: "a@example.com" } });
    if (!braid.ok) throw new Error(braid.error);
    expect(JSON.parse(braid.request.body!).conversions[0]).toMatchObject({ gbraid: "B1" });
    expect(JSON.parse(braid.request.body!).conversions[0].userIdentifiers).toBeUndefined();
    expect(buildRequest("google", { ...base, payload }).ok).toBe(false);
  });

  it("is eligible with a click id or user data, and skipped with neither", () => {
    expect(eligibility("google", {}, noId, null)).toBe("no_match_key");
    expect(eligibility("google", {}, noId, null, { userData: true })).toBeNull();
    expect(eligibility("google", { network_click_param: "wbraid", network_click_id: "w" }, noId, null)).toBeNull();
  });
});
