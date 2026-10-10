/**
 * Provider connectors against Postgres: Meta website events (Pixel +
 * Conversions API), hashed user data for Meta and Google Enhanced
 * Conversions, and Apple AdServices attribution lookups, with consent, the
 * Integrations Center status per capability, and tenant isolation.
 *
 * Every provider API is a local fake (fetchImpl). These are simulated tests,
 * not verification against Meta, Google or Apple.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { adServicesAttributionFor, processAdServicesLookups, queueAdServicesTokens } from "@/modules/attribution/adservices";
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
  process.env.INTEGRATIONS_ENCRYPTION_KEY = "c".repeat(64);
  A = await makeTenant("conn");
  B = await makeTenant("conn-b");
});

async function send(t: T, events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const r = await ingest(sdk, { batch: events }, { mode: "batch" });
  await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
  return r;
}
const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const UA_CLICK = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

describe("Meta website events and hashed user data", () => {
  it("sends a web purchase as action_source website with page URL, user agent, fbp / fbc and hashed email, and Google an Enhanced Conversion", async () => {
    const link = await createLink(A.ctx, A.app.id, { environmentId: A.dev.id, name: "FB web", source: "facebook", webUrl: "https://shop.example" });
    const click = await handleClick(link.code, { method: "GET", headers: new Headers({ "user-agent": UA_CLICK }), ip: "198.51.100.77", query: new URLSearchParams({ fbclid: "IwARweb1" }) });
    if (click.status !== 302 || !click.recorded) throw new Error("click not recorded");

    // The browser Pixel needs the same id as eventID; LeanApp sends the event's own event_id for website events.
    const purchaseId = crypto.randomUUID();
    const meta = await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "meta", name: "Meta web", events: "purchase_completed",
      config: { dataset_id: "PIXEL-1", action_source: "auto", send_user_data: "with_consent" }, credentials: { access_token: "META-WEB-TOKEN" },
    });
    const google = await createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "google", name: "Google EC", events: "purchase_completed", sources: "facebook",
      config: { customer_id: "123-456-7890", conversion_action_id: "77", send_user_data: "unless_denied" },
      credentials: { developer_token: "DEV-T", client_id: "cid", client_secret: "csecret", refresh_token: "rt" },
    });
    await expect(createPostback(A.ctx, A.app.id, {
      environmentId: A.dev.id, network: "meta", name: "Bad", events: "purchase_completed", config: { dataset_id: "1", action_source: "everywhere" }, credentials: { access_token: "x" },
    })).rejects.toBeInstanceOf(ValidationError);

    await send(A, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "web-anon", context: { platform: "android", attribution: { click_id: click.clickId } } }]);
    await send(A, [
      { type: "consent", anonymous_id: "web-anon", user_id: "u-web", consent: { attribution: true } },
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "web-anon", user_id: "u-web", user_properties: { email: " Jane.Doe@Example.com ", phone: "+966 50 123 4567" } },
      { type: "track", event_name: "page_viewed", event_id: crypto.randomUUID(), anonymous_id: "web-anon", context: { platform: "web", user_agent: UA_WEB, attribution: { fbp: "fb.1.1790000000000.555", fbc: "fb.1.1790000000000.IwARweb1", landing_url: "https://shop.example/?fbclid=IwARweb1" } } },
    ]);
    await send(A, [{
      type: "track", event_name: "purchase_completed", event_id: purchaseId, anonymous_id: "web-anon", user_id: "u-web",
      properties: { transaction_id: "w1", revenue: 120, currency: "SAR", url: "https://shop.example/thanks#top" },
      context: { platform: "web", user_agent: UA_WEB },
    }]);

    const sent: { url: string; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/")) return Response.json({ access_token: "GOOGLE-AT" });
      sent.push({ url, body: String(init.body) });
      return Response.json({ events_received: 1 });
    }) as unknown as typeof fetch;
    const result = await deliverPostbacks({ fetchImpl: fake });
    expect(result).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });

    const metaReq = sent.find((s) => s.url.includes("graph.facebook.com"))!;
    const e = JSON.parse(metaReq.body).data[0];
    expect(e).toMatchObject({
      event_name: "Purchase", action_source: "website", event_id: purchaseId, event_source_url: "https://shop.example/thanks",
      user_data: { client_user_agent: UA_WEB, fbp: "fb.1.1790000000000.555", fbc: "fb.1.1790000000000.IwARweb1", em: [sha256Hex("jane.doe@example.com")], ph: [sha256Hex("966501234567")], external_id: [sha256Hex("u-web")] },
      custom_data: { value: 120, currency: "SAR" },
    });
    expect(e.app_data).toBeUndefined();
    expect(metaReq.body).not.toContain("Jane.Doe");

    const googleReq = sent.find((s) => s.url.includes("googleads.googleapis.com"))!;
    const c = JSON.parse(googleReq.body).conversions[0];
    // No Google click on this attribution: an enhanced conversion for leads, matched on hashed email and phone.
    expect(c.gclid).toBeUndefined();
    expect(c).toMatchObject({ conversionAction: "customers/1234567890/conversionActions/77", consent: { adUserData: "GRANTED" } });
    expect(c.userIdentifiers).toEqual([
      { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha256Hex("jane.doe@example.com") },
      { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha256Hex("+966501234567") },
    ]);

    // The delivery log keeps names of match keys, never values, tokens or plain email.
    const rows = await withSystem((db) => db.query<{ postback_id: string; request_summary: Record<string, unknown>; payload: unknown }>(
      "select postback_id, request_summary, payload from platform.attribution_postback_deliveries where postback_id = any($1)", [[meta.id, google.id]]));
    const log = JSON.stringify(rows);
    for (const secret of ["jane", "966501234567", sha256Hex("jane.doe@example.com"), "META-WEB-TOKEN", "GOOGLE-AT", UA_WEB]) expect(log).not.toContain(secret);
    expect(rows.find((r) => r.postback_id === meta.id)!.request_summary).toMatchObject({ events: [{ action_source: "website", match_keys: ["client_user_agent", "em", "external_id", "fbc", "fbp", "ph"] }] });

    // The center reports website events and enhanced conversions as their own capabilities.
    const center = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(center.postbacks!["meta:website"]).toMatchObject({ active: 1, lastSuccessAt: expect.any(Date) });
    expect(center.postbacks!["google:enhanced"]).toMatchObject({ active: 1, lastSuccessAt: expect.any(Date) });
    const centerB = await centerData(B.ctx, B.app.id, B.dev.id);
    expect(centerB.postbacks).toEqual({});
  });

  it("sends no user data when the postback leaves it off or the user hasn't granted consent, and skips website events with nothing to match", async () => {
    await createPostback(A.ctx, A.app.id, { environmentId: A.dev.id, network: "meta", name: "Meta web strict", events: "signup_completed", config: { dataset_id: "PIXEL-2", action_source: "website", send_user_data: "with_consent" }, credentials: { access_token: "T2" } });
    const link = await createLink(A.ctx, A.app.id, { environmentId: A.dev.id, name: "FB 2", source: "facebook", webUrl: "https://shop.example" });
    const click = await handleClick(link.code, { method: "GET", headers: new Headers({ "user-agent": UA_CLICK }), ip: "198.51.100.78", query: new URLSearchParams({ fbclid: "IwARtwo" }) });
    if (click.status !== 302 || !click.recorded) throw new Error("click not recorded");
    await send(A, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "web-2", context: { platform: "android", attribution: { click_id: click.clickId } } }]);
    // No consent decision recorded: with_consent sends no user data; the fbclid still matches.
    await send(A, [
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "web-2", user_id: "u-2", user_properties: { email: "two@example.com" } },
      { type: "track", event_name: "signup_completed", event_id: crypto.randomUUID(), anonymous_id: "web-2", user_id: "u-2", properties: { url: "https://shop.example/welcome" }, context: { platform: "web", user_agent: UA_WEB } },
    ]);
    const bodies: string[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ events_received: 1 });
    }) as unknown as typeof fetch;
    await deliverPostbacks({ fetchImpl: fake });
    expect(bodies).toHaveLength(1);
    const ud = JSON.parse(bodies[0]).data[0].user_data;
    expect(ud).toMatchObject({ client_user_agent: UA_WEB, fbc: expect.stringContaining("IwARtwo") });
    expect(ud.em).toBeUndefined();
    expect(ud.external_id).toBeUndefined();
  });
});

describe("Apple AdServices lookups", () => {
  const token = (n: number) => `${"Q".repeat(120)}${n}AbCd+/==`;

  it("queues each token once, asks Apple, stores the answer, retries 404s, and respects consent and the 24-hour limit", async () => {
    await send(A, [
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "ios-asa", context: { platform: "ios", attribution: { adservices_token: token(1) } } },
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "ios-late", context: { platform: "ios", attribution: { adservices_token: token(2) } } },
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "ios-denied", context: { platform: "ios", attribution: { adservices_token: token(3) } } },
      // The same token again (an SDK retry): one lookup.
      { type: "track", event_name: "app_opened", event_id: crypto.randomUUID(), anonymous_id: "ios-asa", context: { platform: "ios", attribution: { adservices_token: token(1) } } },
    ]);
    await send(B, [{ type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "ios-b", context: { platform: "ios", attribution: { adservices_token: token(4) } } }]);
    // Events this new are left for the next scan (a concurrent insert with a lower id could still commit).
    expect(await queueAdServicesTokens()).toEqual({ scanned: 0, queued: 0 });
    await withSystem((db) => db.query("update platform.events set received_at = now() - interval '5 minutes' where received_at > now() - interval '5 minutes'"));
    expect(await queueAdServicesTokens()).toMatchObject({ queued: 4 });
    await withSystem((db) => db.query("update platform.events set received_at = now() - interval '5 minutes' where received_at > now() - interval '5 minutes'"));
    expect(await queueAdServicesTokens()).toMatchObject({ queued: 0 });
    // Denied after the token was queued: never sent to Apple.
    await send(A, [{ type: "consent", anonymous_id: "ios-denied", consent: { attribution: false } }]);

    const posted: string[] = [];
    const apple = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api-adservices.apple.com/api/v1/");
      const body = String(init.body);
      posted.push(body);
      if (body === token(1)) return Response.json({ attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, adId: 542317136, countryOrRegion: "SA", conversionType: "Download", clickDate: "2026-10-08T17:17Z" });
      if (body === token(4)) return Response.json({ attribution: false });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await processAdServicesLookups({ fetchImpl: apple })).toEqual({ attributed: 1, notAttributed: 1, retrying: 1, failed: 0, expired: 0, skipped: 1 });
    expect(posted).not.toContain(token(3));

    const asa = await withSystem((db) => adServicesAttributionFor(db, A.dev.id, "ios-asa"));
    expect(asa).toMatchObject({ status: "attributed", campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, countryOrRegion: "SA", conversionType: "Download" });
    const rows = await withSystem((db) => db.query<{ anonymous_id: string; status: string; token: string | null; attempts: number; last_status_code: number | null; skip_reason: string | null }>(
      "select anonymous_id, status, token, attempts, last_status_code, skip_reason from platform.adservices_attributions where environment_id = $1 order by anonymous_id", [A.dev.id]));
    expect(rows).toEqual([
      { anonymous_id: "ios-asa", status: "attributed", token: null, attempts: 1, last_status_code: 200, skip_reason: null },
      { anonymous_id: "ios-denied", status: "skipped", token: null, attempts: 1, last_status_code: null, skip_reason: "consent_denied" },
      { anonymous_id: "ios-late", status: "pending", token: token(2), attempts: 1, last_status_code: 404, skip_reason: null },
    ]);

    // Past Apple's 24 hours the token is dropped without another call.
    await withSystem((db) => db.query("update platform.adservices_attributions set next_attempt_at = now(), token_received_at = now() - interval '25 hours' where anonymous_id = 'ios-late'"));
    expect(await processAdServicesLookups({ fetchImpl: apple })).toMatchObject({ expired: 1 });
    expect(posted.filter((p) => p === token(2))).toHaveLength(1);

    // The center: verified by Apple's real (here: faked) answer; B sees only its own lookups; the tenant role can't read tokens.
    const center = await centerData(A.ctx, A.app.id, A.dev.id);
    expect(center.adservices).toMatchObject({ total: 3, attributed: 1, lastAnswerAt: expect.any(Date) });
    expect((await centerData(B.ctx, B.app.id, B.dev.id)).adservices).toMatchObject({ total: 1, attributed: 0 });
    await withTenant({ organizationId: B.org.id, userId: B.user.id }, async (db) => {
      const seen = await db.query<{ environment_id: string }>("select environment_id from platform.adservices_attributions");
      expect(seen.every((r) => r.environment_id === B.dev.id)).toBe(true);
    });
    await expect(withTenant({ organizationId: A.org.id, userId: A.user.id }, (db) => db.query("select token from platform.adservices_attributions"))).rejects.toThrow(/permission denied/);
  });
});
