import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  androidIntentUrl, buildAasa, buildAssetLinks, deepLinkPayload, hostnameOf, inAppBrowser, interstitialCsp, interstitialHtml, iosSchemeUrl, linkUrl,
  normalizeFingerprint, parseLinkPath,
} from "./pure";
import { encodeQr, qrSvg } from "./qr";

const FP = "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5";

describe("link paths", () => {
  it("parses /l/{code} and /l/{prefix}/{code}", () => {
    expect(parseLinkPath("/l/Ab3dE9xY")).toEqual({ prefix: null, code: "Ab3dE9xY" });
    expect(parseLinkPath("/l/shop-dev/Ab3dE9xY/")).toEqual({ prefix: "shop-dev", code: "Ab3dE9xY" });
    expect(parseLinkPath("/l/Shop/Ab3dE9xY")).toBeNull(); // prefixes are lower case
    expect(parseLinkPath("/l/shop/Ab3dE9xY/extra")).toBeNull();
    expect(parseLinkPath("/x/Ab3dE9xY")).toBeNull();
    expect(linkUrl("https://l.leanapp.io/", "Ab3dE9xY", "shop")).toBe("https://l.leanapp.io/l/shop/Ab3dE9xY");
    expect(linkUrl("https://api.leanapp.io", "Ab3dE9xY", null)).toBe("https://api.leanapp.io/l/Ab3dE9xY");
  });

  it("normalizes hosts and fingerprints", () => {
    expect(hostnameOf("L.LeanApp.io:443")).toBe("l.leanapp.io");
    expect(hostnameOf("https://links.example.com/x")).toBe("links.example.com");
    expect(hostnameOf("")).toBeNull();
    expect(normalizeFingerprint(FP.toLowerCase().replace(/:/g, ""))).toBe(FP);
    expect(normalizeFingerprint("AB:CD")).toBeNull();
  });
});

describe("well-known documents", () => {
  const shop = { link_prefix: "shop", ios_team_id: "ABCDE12345", ios_bundle_ids: ["com.shop.app", "com.shop.app.clip"], android_package: "com.shop.app", android_sha256: [FP] };
  const shopDev = { link_prefix: "shop-dev", ios_team_id: "ABCDE12345", ios_bundle_ids: ["com.shop.app.dev"], android_package: null, android_sha256: [] };
  const other = { link_prefix: "rides", ios_team_id: null, ios_bundle_ids: [], android_package: "com.rides", android_sha256: [FP] };

  it("scopes each app to its own prefix in apple-app-site-association", () => {
    expect(buildAasa([shop, shopDev, other])).toEqual({
      applinks: {
        details: [
          { appIDs: ["ABCDE12345.com.shop.app", "ABCDE12345.com.shop.app.clip"], components: [{ "/": "/l/shop/*" }] },
          { appIDs: ["ABCDE12345.com.shop.app.dev"], components: [{ "/": "/l/shop-dev/*" }] },
        ],
      },
    });
  });

  it("lists every Android app of the host in assetlinks.json", () => {
    expect(buildAssetLinks([shop, shopDev, other])).toEqual([
      { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.rides", sha256_cert_fingerprints: [FP] } },
      { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.shop.app", sha256_cert_fingerprints: [FP] } },
    ]);
  });
});

describe("deep link payload", () => {
  it("merges the link's parameters with the opened URL's, never campaign parameters", () => {
    const opened = new URLSearchParams("promo=X&utm_source=ig&click_id=lac_abcdefgh12&ref=influencer_1&color=red");
    expect(deepLinkPayload("/product/42?color=blue", opened)).toEqual({
      path: "/product/42",
      params: { promo: "X", ref: "influencer_1", color: "blue" },
      url: "/product/42?promo=X&ref=influencer_1&color=blue",
    });
    expect(deepLinkPayload("myapp://offers", null)).toEqual({ path: "myapp://offers", params: {}, url: "myapp://offers" });
    expect(deepLinkPayload(null, new URLSearchParams("a=1"))).toEqual({ path: null, params: { a: "1" }, url: null });
  });
});

describe("social in-app browsers", () => {
  it("detects Instagram, Facebook, TikTok and Snapchat but not real browsers", () => {
    expect(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 324.0.3.21.98 (iPhone15,2; iOS 17_4; ar_SA)")).toBe("Instagram");
    expect(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/455.0.0.39.106;FBBV/1]")).toBe("Facebook");
    expect(inAppBrowser("Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 musical_ly_2023405030 BytedanceWebview/d8a21c6")).toBe("TikTok");
    expect(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/12.80.0.40 (like Safari/8617.2.4.10.8)")).toBe("Snapchat");
    expect(inAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBeNull();
    expect(inAppBrowser(null)).toBeNull();
  });

  it("builds Android intent and iOS scheme URLs", () => {
    expect(androidIntentUrl("https://l.leanapp.io/l/shop/Ab3dE9xY?click_id=lac_x", "com.shop.app", "https://play.google.com/store/apps/details?id=com.shop.app"))
      .toBe("intent://l.leanapp.io/l/shop/Ab3dE9xY?click_id=lac_x#Intent;scheme=https;package=com.shop.app;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.shop.app;end");
    expect(iosSchemeUrl("shop", deepLinkPayload("/product/42?color=blue", null), { click_id: "lac_abc", utm_source: "instagram", utm_medium: null }))
      .toBe("shop://product/42?color=blue&click_id=lac_abc&utm_source=instagram");
    expect(iosSchemeUrl("shop", deepLinkPayload("other://offers", null), {})).toBe("shop://offers");
  });

  it("renders a script-free page whose styles carry the CSP nonce, escaping the app name", () => {
    const html = interstitialHtml({ appName: "Shop <b>", browser: "Instagram", os: "ios", openUrl: "shop://p?a=1&b=2", storeUrl: "https://apps.apple.com/app/id1", nonce: "n0nce", arabic: false });
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).not.toContain("<script");
    expect(html).toContain("Shop &lt;b&gt;");
    expect(html).toContain('href="shop://p?a=1&amp;b=2"');
    expect(html).toContain("Open in Safari");
    const ar = interstitialHtml({ appName: "متجر", browser: "TikTok", os: "android", openUrl: null, storeUrl: "https://play.google.com/x", nonce: "n", arabic: true });
    expect(ar).toContain('dir="rtl"');
    expect(ar).not.toContain("افتح في التطبيق"); // no open button without a way to open the app
    expect(interstitialCsp("n0nce")).toBe("default-src 'none'; style-src 'nonce-n0nce'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });
});

describe("QR codes", () => {
  const fingerprint = (m: boolean[][]) => createHash("sha256").update(m.map((r) => r.map((b) => (b ? 1 : 0)).join("")).join("\n")).digest("hex");

  // Golden matrices: decoded correctly by zxing-cpp and OpenCV when the encoder was written
  // (208 text / level / mask combinations, versions 1–40), kept here as regression checks.
  it("encodes links to known-good matrices", () => {
    const a = encodeQr("https://api.leanapp.io/l/shop/Ab3dE9xY");
    expect([a.version, a.mask, a.size]).toEqual([3, 2, 29]);
    expect(fingerprint(a.modules)).toBe("bb1b3c4fb53940830f2d478b12ef8c1a599c1f8590b4b44e1fdf615fc8f5e3ed");
    const b = encodeQr("HELLO");
    expect([b.version, b.mask]).toEqual([1, 4]);
    expect(fingerprint(b.modules)).toBe("c346c75add5698735afe3f7eb4f3e6c57ccefd9563f45f65c6d76aa518fb6f91");
  });

  it("draws finder patterns, the dark module and grows with the data", () => {
    const q = encodeQr("x".repeat(300));
    expect(q.version).toBeGreaterThan(9);
    const finder = [[1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 1], [1, 0, 1, 1, 1, 0, 1]];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 7; x++) expect(q.modules[y][x]).toBe(finder[y][x] === 1);
    expect(q.modules[q.size - 8][8]).toBe(true);
    expect(() => encodeQr("x".repeat(3000))).toThrow(/too long/);
  });

  it("renders a compact SVG with a quiet zone", () => {
    const svg = qrSvg("https://api.leanapp.io/l/shop/Ab3dE9xY", { title: "Link & QR" });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 37 37"/);
    expect(svg).toContain("<title>Link &amp; QR</title>");
    expect(svg).toContain('<path d="M4 4h7v1h-7z');
  });
});
