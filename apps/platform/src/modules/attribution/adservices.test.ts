import { describe, expect, it } from "vitest";
import { ADSERVICES_URL, lookupAdServicesToken, parseAdServicesResponse, plausibleToken, retryDelaySeconds, tokenHash } from "./adservices";

/**
 * Apple AdServices client against a fake fetch: simulated, not verification
 * against Apple's live API.
 */
const TOKEN = "AAAABBBBccccDDDD1234567890+/abcdefghijklmnopqrstuvwxyz==";

function fake(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("AdServices response", () => {
  it("reads Apple's attributed answer, including the detailed fields when present", () => {
    expect(parseAdServicesResponse({ attribution: true, orgId: 40669820, campaignId: 542370539, conversionType: "Download", clickDate: "2020-04-08T17:17Z", claimType: "Click", adGroupId: 542317095, countryOrRegion: "US", keywordId: 87675432, adId: 542317136 })).toEqual({
      attribution: true, orgId: 40669820, campaignId: 542370539, adGroupId: 542317095, keywordId: 87675432, adId: 542317136,
      countryOrRegion: "US", conversionType: "Download", claimType: "Click", clickDate: "2020-04-08T17:17Z",
    });
  });

  it("keeps nothing but the verdict when Apple says not attributed, and rejects other shapes", () => {
    expect(parseAdServicesResponse({ attribution: false, campaignId: 1 })).toMatchObject({ attribution: false, campaignId: null, orgId: null });
    expect(parseAdServicesResponse({ campaignId: 1 })).toBeNull();
    expect(parseAdServicesResponse(null)).toBeNull();
  });
});

describe("AdServices lookup", () => {
  it("posts the token as text/plain to Apple's documented endpoint", async () => {
    const f = fake(200, { attribution: true, campaignId: 7, orgId: 1 });
    const r = await lookupAdServicesToken(TOKEN, f.impl);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api-adservices.apple.com/api/v1/");
    expect(ADSERVICES_URL).toBe(f.calls[0].url);
    expect(f.calls[0].init).toMatchObject({ method: "POST", headers: { "Content-Type": "text/plain" }, body: TOKEN });
    expect(r).toMatchObject({ kind: "answer", status: 200, result: { attribution: true, campaignId: 7 } });
  });

  it("retries 404 (token not ready), 5xx and network errors; 400 is final", async () => {
    expect(await lookupAdServicesToken(TOKEN, fake(404, "").impl)).toMatchObject({ kind: "retry", status: 404 });
    expect(await lookupAdServicesToken(TOKEN, fake(503, "").impl)).toMatchObject({ kind: "retry", status: 503 });
    expect(await lookupAdServicesToken(TOKEN, fake(400, "").impl)).toMatchObject({ kind: "failed", status: 400 });
    expect(await lookupAdServicesToken(TOKEN, fake(200, "not json").impl)).toMatchObject({ kind: "failed", status: 200 });
    const broken = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await lookupAdServicesToken(TOKEN, broken);
    expect(r).toMatchObject({ kind: "retry", status: null });
    // The token never appears in an error.
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("refuses anything that isn't token-shaped without calling Apple", async () => {
    const f = fake(200, {});
    expect(await lookupAdServicesToken("short", f.impl)).toMatchObject({ kind: "failed" });
    expect(await lookupAdServicesToken("has spaces in it which tokens never do", f.impl)).toMatchObject({ kind: "failed" });
    expect(f.calls).toHaveLength(0);
    expect(plausibleToken(TOKEN)).toBe(true);
  });

  it("backs off and then gives up; tokens are deduplicated by hash", () => {
    expect([1, 2, 3, 6, 7].map(retryDelaySeconds)).toEqual([60, 300, 900, 6 * 3600, null]);
    expect(tokenHash(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(TOKEN)).toBe(tokenHash(TOKEN));
  });
});
