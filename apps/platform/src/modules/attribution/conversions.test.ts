import { describe, expect, it } from "vitest";
import { eligibility, parseProviderError, requestSummary, validateConversionBody } from "./conversions";
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
