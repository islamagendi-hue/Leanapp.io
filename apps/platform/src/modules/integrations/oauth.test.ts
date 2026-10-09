import { describe, expect, it } from "vitest";
import { authorizeUrl, codeFrom, exchangeCode, oauthConfigured, redirectUri } from "./oauth";
import { AD_PROVIDERS } from "./registry";

const env = {
  META_APP_ID: "m-id", META_APP_SECRET: "m-sec",
  GOOGLE_ADS_CLIENT_ID: "g-id", GOOGLE_ADS_CLIENT_SECRET: "g-sec", GOOGLE_ADS_DEVELOPER_TOKEN: "g-dev",
  TIKTOK_APP_ID: "t-id", TIKTOK_APP_SECRET: "t-sec",
  SNAPCHAT_CLIENT_ID: "s-id", SNAPCHAT_CLIENT_SECRET: "s-sec",
};

describe("OAuth (simulated: no provider is called)", () => {
  it("is offered only when the operator configured the provider app", () => {
    for (const p of AD_PROVIDERS) {
      expect(oauthConfigured(p, {})).toBe(false);
      expect(oauthConfigured(p, env)).toBe(true);
    }
    expect(oauthConfigured("google_ads", { ...env, GOOGLE_ADS_DEVELOPER_TOKEN: "" })).toBe(false);
  });

  it("builds authorization URLs carrying the state and the fixed redirect URI", () => {
    const redirect = redirectUri("https://app.example.com/", "meta_ads");
    expect(redirect).toBe("https://app.example.com/integrations/oauth/meta_ads/callback");
    const hosts: Record<string, string> = { meta_ads: "www.facebook.com", google_ads: "accounts.google.com", tiktok_ads: "business-api.tiktok.com", snapchat_ads: "accounts.snapchat.com" };
    for (const p of AD_PROVIDERS) {
      const u = new URL(authorizeUrl(p, { redirectUri: redirect, state: "st4te" }, env));
      expect(u.host).toBe(hosts[p]);
      expect(u.searchParams.get("state")).toBe("st4te");
      expect(u.searchParams.get("redirect_uri")).toBe(redirect);
    }
    const g = new URL(authorizeUrl("google_ads", { redirectUri: redirect, state: "s" }, env));
    expect(g.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/adwords");
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(new URL(authorizeUrl("meta_ads", { redirectUri: redirect, state: "s" }, env)).searchParams.get("scope")).toBe("ads_read");
  });

  it("reads the code (TikTok's auth_code) and rejects oversized ones", () => {
    expect(codeFrom("tiktok_ads", new URLSearchParams("auth_code=abc"))).toBe("abc");
    expect(codeFrom("meta_ads", new URLSearchParams("code=xyz"))).toBe("xyz");
    expect(codeFrom("meta_ads", new URLSearchParams(`code=${"x".repeat(3000)}`))).toBeNull();
  });

  it("exchanges a code server-side and marks the secrets as using LeanApp's app", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(url);
      if (url.includes("fb_exchange_token")) return Response.json({ access_token: "long", expires_in: 5184000 });
      if (url.includes("graph.facebook.com")) return Response.json({ access_token: "short" });
      if (url.includes("oauth2.googleapis.com")) {
        expect(String(init.body)).toContain("grant_type=authorization_code");
        return Response.json({ refresh_token: "g-rt", scope: "https://www.googleapis.com/auth/adwords" });
      }
      return Response.json({ code: 0, data: { access_token: "tt", advertiser_ids: ["1", "2"] } });
    }) as unknown as typeof fetch;
    const http = { fetchImpl, baseDelayMs: 0 };
    const meta = await exchangeCode("meta_ads", "c", "https://x/cb", http, env);
    expect(meta.secrets).toEqual({ access_token: "long", oauth_app: "leanapp" });
    expect(meta.expiresAt).toBeInstanceOf(Date);
    expect((await exchangeCode("google_ads", "c", "https://x/cb", http, env)).secrets).toEqual({ refresh_token: "g-rt", oauth_app: "leanapp" });
    const tt = await exchangeCode("tiktok_ads", "c", "https://x/cb", http, env);
    expect(tt.accountIds).toEqual(["1", "2"]);
    await expect(exchangeCode("snapchat_ads", "c", "https://x/cb", http, {})).rejects.toMatchObject({ kind: "config" });
  });
});
