import { describe, expect, it } from "vitest";
import { AD_ADAPTERS } from "./ads";
import { capabilityState, type CenterInput } from "./center";
import { AD_PROVIDERS, CATEGORIES, PROVIDERS, providerById, providerRoles } from "./registry";
import { chosenAccounts, mergeRows, resolveAccounts, spendAggregate } from "./sync";

const empty: CenterInput = { connections: [], postbacks: {}, messaging: [], webhooks: { total: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null }, skan: { received: 0, lastAt: null }, links: { links: 0, lastClickAt: null }, deepLinks: { configured: false, lastCheckedAt: null }, sdk: { lastUsedAt: null, activeKeys: 0 }, paymentsConnected: false };
const cap = (provider: string, id: string) => {
  const p = providerById(provider)!;
  return [p, p.capabilities.find((c) => c.id === id)!] as const;
};

describe("registry", () => {
  it("covers every category, has unique ids, and an adapter per built ad provider", () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    for (const p of PROVIDERS) expect(CATEGORIES.map((c) => c.id)).toContain(p.category);
    for (const p of AD_PROVIDERS) expect(AD_ADAPTERS[p].provider).toBe(p);
    // Descriptor-only providers have no capability (so no setup action), but cite the official API.
    for (const p of PROVIDERS.filter((x) => x.implementation === "descriptor")) {
      expect(p.capabilities).toEqual([]);
      expect(p.docsUrl).toMatch(/^https:\/\//);
    }
    for (const p of PROVIDERS.filter((x) => x.implementation === "built")) for (const c of p.capabilities) expect(c.setupPath).toBeTruthy();
  });

  it("keeps inbound and outbound apart: Meta is both a data source and a service provider", () => {
    expect(providerRoles(providerById("meta_ads")!)).toEqual(["data_source", "service_provider"]);
    expect(providerRoles(providerById("leanapp_webhooks")!)).toEqual(["service_provider"]);
  });
});

describe("capability state", () => {
  it("reads ad reporting from the connection, and conversions from postbacks, independently", () => {
    const withReporting: CenterInput = {
      ...empty,
      connections: [{ provider: "meta_ads", capabilities: [{ capability: "ad_reporting", status: "error", status_detail: "auth", last_success_at: null, last_error_at: new Date("2026-10-01"), last_error: "Meta 400 (code 190): expired", data_fresh_through: "2026-09-30" }] }],
    };
    const [p, reporting] = cap("meta_ads", "ad_reporting");
    expect(capabilityState(p, reporting, withReporting)).toMatchObject({ status: "error", freshThrough: "2026-09-30", errors: [{ message: "Meta 400 (code 190): expired" }] });
    const [, conversions] = cap("meta_ads", "conversions_outbound");
    expect(capabilityState(p, conversions, withReporting).status).toBe("not_configured");
    const [, spend] = cap("meta_ads", "spend_import");
    expect(capabilityState(p, spend, withReporting).status).toBe("not_configured");

    const pb = (o: object) => ({ ...empty, postbacks: { meta: { postbacks: 1, active: 1, withCredentials: 1, lastSuccessAt: null, lastFailureAt: null, recentErrors: [], skipped: 0, ...o } } });
    expect(capabilityState(p, conversions, pb({ withCredentials: 0 })).status).toBe("credentials_missing");
    expect(capabilityState(p, conversions, pb({})).status).toBe("unverified");
    expect(capabilityState(p, conversions, pb({ lastSuccessAt: new Date("2026-10-02") })).status).toBe("verified");
    expect(capabilityState(p, conversions, pb({ lastSuccessAt: new Date("2026-10-01"), lastFailureAt: new Date("2026-10-02"), recentErrors: [{ at: new Date("2026-10-02"), error: "HTTP 400", code: "100" }] }))).toMatchObject({ status: "error", errors: [{ code: "100" }] });
  });

  it("derives the other parts from their own records, and hides what the role can't see", () => {
    const [w, webhook] = cap("leanapp_webhooks", "webhook_delivery");
    expect(capabilityState(w, webhook, empty).status).toBe("not_configured");
    expect(capabilityState(w, webhook, { ...empty, webhooks: null }).status).toBeNull();
    const [m, push] = cap("fcm", "push_delivery");
    expect(capabilityState(m, push, { ...empty, messaging: [{ provider: "fcm", status: "active", last_error: null, last_used_at: null, live_verified_at: null }] }).status).toBe("unverified");
    expect(capabilityState(m, push, { ...empty, messaging: [{ provider: "fcm", status: "active", last_error: null, last_used_at: new Date(), live_verified_at: new Date() }] }).status).toBe("verified");
    const [s, billing] = cap("stripe_billing", "plan_billing");
    expect(capabilityState(s, billing, { ...empty, paymentsConnected: true }).status).toBe("unverified");
    const [l, sdk] = cap("leanapp_sdk", "event_ingestion");
    expect(capabilityState(l, sdk, { ...empty, sdk: { lastUsedAt: new Date(), activeKeys: 1 } }).status).toBe("verified");
  });
});

describe("sync helpers", () => {
  const row = { day: "2026-10-01", accountId: "1", currency: "SAR", campaignId: "c1", campaignName: "Eid", adsetId: "", adsetName: null, adId: "", adName: null, impressions: 10, clicks: 1, spend: 1.005, conversions: null };

  it("merges duplicate provider rows and aggregates spend per day, campaign and currency", () => {
    const merged = mergeRows([row, { ...row, impressions: 5, spend: 2, conversions: 1 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ impressions: 15, spend: 3.005, conversions: 1 });
    expect(spendAggregate([row, { ...row, spend: 2 }, { ...row, campaignId: "c2", campaignName: null, spend: 4 }, { ...row, currency: "USD", spend: 1 }])).toEqual([
      { day: "2026-10-01", campaign: "Eid", currency: "SAR", amount: 3.01 },
      { day: "2026-10-01", campaign: "c2", currency: "SAR", amount: 4 },
      { day: "2026-10-01", campaign: "Eid", currency: "USD", amount: 1 },
    ]);
  });

  it("only imports chosen accounts the credentials can read (Google: manager access allowed)", () => {
    expect(chosenAccounts("meta_ads", { ad_account_ids: "act_123, 456" })).toEqual(["123", "456"]);
    const listed = [{ id: "123", name: "A", currency: "SAR", timezone: "UTC" }];
    expect(resolveAccounts("meta_ads", ["123", "456"], listed)).toEqual({ accounts: listed, unreadable: ["456"] });
    expect(resolveAccounts("google_ads", ["123", "456"], listed).unreadable).toEqual([]);
  });
});
