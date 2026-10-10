/**
 * TikTok Events API and Snap Conversions API website events against Postgres:
 * the web SDK's _ttp / _scid cookie ids, page URL and user agent read at send
 * time, hashed user data under consent, validation of the postback settings,
 * the Integrations Center status per capability, and tenant isolation.
 *
 * Every provider API is a local fake (fetchImpl). These are simulated tests,
 * not verification against TikTok or Snap.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { sha256Hex } from "@/modules/attribution/conversions";
import { deliverPostbacks } from "@/modules/attribution/delivery";
import { createLink, createPostback, handleClick } from "@/modules/attribution/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { centerData } from "@/modules/integrations/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;

beforeAll(async () => {
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "d".repeat(64);
  A = await makeTenant("ttsnap");
  B = await makeTenant("ttsnap-b");
});

async function send(t: T, events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const r = await ingest(sdk, { batch: events }, { mode: "batch" });
  await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
  return r;
}
const UA_WEB = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const UA_CLICK = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const TTP = "2Qx8mJf1nT0aBcDeFgHiJkLmNoP";
const SCID = "0e8b4a2c-3f1d-4c55-9a77-1b2c3d4e5f60";

async function clickFrom(t: T, source: string, param: string, value: string, ip: string) {
  const link = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: `${source} web`, source, webUrl: "https://shop.example" });
  const click = await handleClick(link.code, { method: "GET", headers: new Headers({ "user-agent": UA_CLICK }), ip, query: new URLSearchParams({ [param]: value }) });
  if (click.status !== 302 || !click.recorded) throw new Error("click not recorded");
  return click.clickId;
}

describe("postback settings", () => {
  it("needs the pixel id for website events and the app id for app events", async () => {
    const base = { environmentId: A.dev.id, name: "x", events: "purchase_completed", credentials: { access_token: "t" } };
    await expect(createPostback(A.ctx, A.app.id, { ...base, network: "tiktok", config: { action_source: "website", tiktok_app_id: "7001" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPostback(A.ctx, A.app.id, { ...base, network: "tiktok", config: { action_source: "auto", tiktok_pixel_code: "CP" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPostback(A.ctx, A.app.id, { ...base, network: "snapchat", config: { action_source: "website" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPostback(A.ctx, A.app.id, { ...base, network: "snapchat", config: { snap_pixel_id: "px", action_source: "web" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPostback(A.ctx, A.app.id, { ...base, network: "tiktok", config: { tiktok_pixel_code: "CP", action_source: "website", send_user_data: "always" } })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("TikTok and Snap website events", () => {
  it("sends web purchases with the page URL, user agent, click id, _ttp / _scid and hashed user data, and reports them as their own capability", async () => {
    const ttClick = await clickFrom(A, "tiktok", "ttclid", "E.C.P.tt1", "198.51.100.91");
    const tt = await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "tiktok", name: "TikTok web", events: "purchase_completed",
      config: { tiktok_pixel_code: "CPIXEL1", tiktok_app_id: "7001", action_source: "auto", send_user_data: "with_consent", test_event_code: "TEST42" }, credentials: { access_token: "TT-WEB-TOKEN" },
    });
    // TikTok visitor: installed the app from the click, then buys on the website.
    const ttPurchase = crypto.randomUUID();
    await send(A, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "tt-anon", context: { platform: "android", attribution: { click_id: ttClick } } }]);
    await send(A, [
      { type: "consent", anonymous_id: "tt-anon", user_id: "u-tt", consent: { attribution: true } },
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "tt-anon", user_id: "u-tt", user_properties: { email: " Sara@Example.com ", phone: "+971 50 765 4321" } },
      // The SDK sends the cookie ids on the session's events; the purchase itself may not carry them.
      { type: "track", event_name: "page_viewed", event_id: crypto.randomUUID(), anonymous_id: "tt-anon", context: { platform: "web", user_agent: UA_WEB, attribution: { ttp: TTP, landing_url: "https://shop.example/?ttclid=E.C.P.tt1" } } },
    ]);
    await send(A, [{
      type: "track", event_name: "purchase_completed", event_id: ttPurchase, anonymous_id: "tt-anon", user_id: "u-tt",
      properties: { transaction_id: "tt-1", revenue: 200, currency: "AED", url: "https://shop.example/thanks#done" }, context: { platform: "web", user_agent: UA_WEB },
    }]);

    const scClick = await clickFrom(A, "snapchat", "ScCid", "sc-web-1", "198.51.100.92");
    const snap = await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "snapchat", name: "Snap web", events: "purchase_completed",
      config: { snap_pixel_id: "SNAP-PIXEL-1", action_source: "website", send_user_data: "unless_denied" }, credentials: { access_token: "SNAP-WEB-TOKEN" },
    });
    const scPurchase = crypto.randomUUID();
    await send(A, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "sc-anon", context: { platform: "android", attribution: { click_id: scClick } } }]);
    await send(A, [
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "sc-anon", user_id: "u-sc", user_properties: { email: "omar@example.com" } },
      { type: "track", event_name: "purchase_completed", event_id: scPurchase, anonymous_id: "sc-anon", user_id: "u-sc",
        properties: { transaction_id: "sc-1", revenue: 90, currency: "SAR", url: "https://shop.example/paid" }, context: { platform: "web", user_agent: UA_WEB, attribution: { scid: SCID } } },
    ]);

    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return url.includes("tiktok") ? Response.json({ code: 0, message: "OK", request_id: "r1" }) : Response.json({ status: "SUCCESS" });
    }) as unknown as typeof fetch;
    const result = await deliverPostbacks({ fetchImpl: fake });
    expect(result).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });

    const ttReq = sent.find((s) => s.url.includes("business-api.tiktok.com"))!;
    expect(ttReq.headers["Access-Token"]).toBe("TT-WEB-TOKEN");
    const ttBody = JSON.parse(ttReq.body);
    expect(ttBody).toMatchObject({ event_source: "web", event_source_id: "CPIXEL1", test_event_code: "TEST42" });
    expect(ttBody.data[0]).toMatchObject({
      event: "CompletePayment", event_id: ttPurchase, page: { url: "https://shop.example/thanks" },
      user: { ttclid: "E.C.P.tt1", ttp: TTP, user_agent: UA_WEB, email: sha256Hex("sara@example.com"), phone: sha256Hex("+971507654321"), external_id: sha256Hex("u-tt") },
      properties: { value: 200, currency: "AED" },
    });
    expect(ttReq.body).not.toContain("Sara");

    const scReq = sent.find((s) => s.url.includes("tr.snapchat.com"))!;
    expect(scReq.url).toBe("https://tr.snapchat.com/v3/SNAP-PIXEL-1/events?access_token=SNAP-WEB-TOKEN");
    expect(JSON.parse(scReq.body).data[0]).toMatchObject({
      event_name: "PURCHASE", action_source: "WEB", event_id: scPurchase, event_source_url: "https://shop.example/paid",
      // No consent decision recorded: unless_denied still sends hashed data.
      user_data: { client_user_agent: UA_WEB, sc_click_id: "sc-web-1", sc_cookie1: SCID, em: [sha256Hex("omar@example.com")], external_id: [sha256Hex("u-sc")] },
      custom_data: { value: 90, currency: "SAR" },
    });

    // The delivery log keeps the names of match keys, never values, tokens or plain contact data.
    const rows = await withSystem((db) => db.query<{ postback_id: string; request_summary: Record<string, unknown> }>(
      "select postback_id, request_summary from platform.attribution_postback_deliveries where postback_id = any($1)", [[tt.id, snap.id]]));
    const log = JSON.stringify(rows);
    for (const secret of ["TT-WEB-TOKEN", "SNAP-WEB-TOKEN", "sara", "omar", TTP, SCID, UA_WEB, sha256Hex("sara@example.com")]) expect(log).not.toContain(secret);
    expect(rows.find((r) => r.postback_id === tt.id)!.request_summary).toMatchObject({
      endpoint: "business-api.tiktok.com/open_api/v1.3/event/track/", test_event: true,
      events: [{ action_source: "web", match_keys: ["email", "external_id", "phone", "ttclid", "ttp", "user_agent"] }],
    });
    expect(rows.find((r) => r.postback_id === snap.id)!.request_summary).toMatchObject({
      endpoint: "tr.snapchat.com/v3/SNAP-PIXEL-1/events", events: [{ action_source: "WEB", match_keys: ["client_user_agent", "em", "external_id", "sc_click_id", "sc_cookie1"] }],
    });

    // The center reports website events per network; a TikTok "auto" postback counts for app events too, Snap "website" doesn't.
    const center = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(center.postbacks!["tiktok:website"]).toMatchObject({ active: 1, lastSuccessAt: expect.any(Date) });
    expect(center.postbacks!["tiktok"]).toMatchObject({ active: 1 });
    expect(center.postbacks!["snapchat:website"]).toMatchObject({ active: 1, lastSuccessAt: expect.any(Date) });
    expect(center.postbacks!["snapchat"]).toBeUndefined();
    const centerB = await centerData(B.ctx, B.app.id, B.dev.id);
    expect(centerB.postbacks).toEqual({});
  });

  it("skips users who denied attribution consent, and sends no user data without a grant", async () => {
    await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "tiktok", name: "TikTok signups", events: "signup_completed",
      config: { tiktok_pixel_code: "CPIXEL2", action_source: "website", send_user_data: "with_consent" }, credentials: { access_token: "T2" },
    });
    const c1 = await clickFrom(A, "tiktok", "ttclid", "E.C.P.two", "198.51.100.93");
    const c2 = await clickFrom(A, "tiktok", "ttclid", "E.C.P.three", "198.51.100.94");
    await send(A, [
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "tt-2", context: { platform: "android", attribution: { click_id: c1 } } },
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "tt-3", context: { platform: "android", attribution: { click_id: c2 } } },
    ]);
    await send(A, [
      // tt-2: no consent decision; has a click id, so it is sent, without hashed data.
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "tt-2", user_id: "u-2", user_properties: { email: "two@example.com" } },
      { type: "track", event_name: "signup_completed", event_id: crypto.randomUUID(), anonymous_id: "tt-2", user_id: "u-2", properties: { url: "https://shop.example/welcome" }, context: { platform: "web", user_agent: UA_WEB } },
      // tt-3: denied attribution consent: never sent.
      { type: "consent", anonymous_id: "tt-3", consent: { attribution: false } },
      { type: "track", event_name: "signup_completed", event_id: crypto.randomUUID(), anonymous_id: "tt-3", properties: { url: "https://shop.example/welcome" }, context: { platform: "web", user_agent: UA_WEB, attribution: { ttp: TTP } } },
    ]);
    const bodies: string[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ code: 0, message: "OK" });
    }) as unknown as typeof fetch;
    const r = await deliverPostbacks({ fetchImpl: fake });
    expect(bodies).toHaveLength(1);
    const user = JSON.parse(bodies[0]).data[0].user;
    expect(user).toMatchObject({ ttclid: "E.C.P.two", user_agent: UA_WEB });
    expect(user.email).toBeUndefined();
    expect(user.external_id).toBeUndefined();
    const skipped = await withSystem((db) => db.query<{ skip_reason: string }>(
      "select d.skip_reason from platform.attribution_postback_deliveries d join platform.attribution_postbacks p on p.id = d.postback_id where p.name = 'TikTok signups' and d.status = 'skipped'"));
    expect(skipped.map((s) => s.skip_reason)).toEqual(["consent_denied"]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it("skips a Snap website event with no ScCid, no _scid cookie and no user data allowed", async () => {
    await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "snapchat", name: "Snap leads", events: "lead_submitted", sources: "snapchat",
      config: { snap_pixel_id: "SNAP-PIXEL-2", action_source: "website" }, credentials: { access_token: "S2" },
    });
    // A Snapchat link clicked without a ScCid: the install is attributed to Snapchat by source only.
    const link = await createLink(A.ctx, A.app.id, { environmentId: A.dev.id, name: "snap plain", source: "snapchat", webUrl: "https://shop.example" });
    const click = await handleClick(link.code, { method: "GET", headers: new Headers({ "user-agent": UA_CLICK }), ip: "198.51.100.95", query: new URLSearchParams() });
    if (click.status !== 302 || !click.recorded) throw new Error("click not recorded");
    await send(A, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "sc-plain", context: { platform: "android", attribution: { click_id: click.clickId } } }]);
    await send(A, [{ type: "track", event_name: "lead_submitted", event_id: crypto.randomUUID(), anonymous_id: "sc-plain", user_id: "u-plain", properties: { url: "https://shop.example/lead" }, context: { platform: "web", user_agent: UA_WEB } }]);
    const calls: string[] = [];
    await deliverPostbacks({ fetchImpl: (async (url: string) => { calls.push(url); return Response.json({}); }) as unknown as typeof fetch });
    expect(calls.filter((u) => u.includes("SNAP-PIXEL-2"))).toEqual([]);
    const rows = await withSystem((db) => db.query<{ status: string; skip_reason: string | null }>(
      "select d.status, d.skip_reason from platform.attribution_postback_deliveries d join platform.attribution_postbacks p on p.id = d.postback_id where p.name = 'Snap leads'"));
    expect(rows).toEqual([{ status: "skipped", skip_reason: "no_match_key" }]);
  });
});
