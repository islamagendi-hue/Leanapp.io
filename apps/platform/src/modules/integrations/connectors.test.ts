import { describe, expect, it } from "vitest";
import { NETWORKS } from "@/modules/attribution/networks";
import { AD_ADAPTERS } from "./ads";
import { capabilityState, postbackKey, type CenterInput } from "./center";
import { CONNECTORS, connectorCapabilities, connectorFor, destinationsOf } from "./connectors";
import { AD_PROVIDERS, providerById } from "./registry";

const empty: CenterInput = { connections: [], postbacks: {}, adservices: { total: 0, attributed: 0, lastAnswerAt: null, lastFailureAt: null, lastError: null }, messaging: [], webhooks: null, skan: null, links: null, deepLinks: null, sdk: null, paymentsConnected: null };

describe("connector architecture", () => {
  it("agrees with the registry: every connector capability is listed for its provider, and nothing else", () => {
    for (const c of CONNECTORS) {
      const p = providerById(c.provider);
      expect(p, c.provider).toBeTruthy();
      expect(p!.capabilities.map((x) => x.id).sort()).toEqual(connectorCapabilities(c).sort());
    }
    for (const ad of AD_PROVIDERS) expect(connectorFor(ad)?.costImport).toBe(ad);
  });

  it("keeps cost import, event delivery and attribution lookups as separate parts", () => {
    for (const c of CONNECTORS) {
      if (c.costImport) expect(AD_ADAPTERS[c.costImport].provider).toBe(c.provider);
      for (const d of c.eventDelivery) expect(NETWORKS).toContain(d.network);
    }
    const meta = connectorFor("meta_ads")!;
    expect(meta.eventDelivery.map((d) => [d.capability, d.actionSource])).toEqual([["conversions_outbound", "app"], ["web_conversions_outbound", "website"]]);
    expect(connectorFor("apple_search_ads")).toMatchObject({ costImport: null, eventDelivery: [], attributionLookup: "apple_adservices", auth: { methods: ["none"] } });
  });

  it("routes a postback to destinations by its settings, the same way the center groups them", () => {
    const caps = (network: string, config: Record<string, string>) => destinationsOf(network, config).map((d) => postbackKey(d.network, d.capability));
    expect(caps("meta", {})).toEqual(["meta"]);
    expect(caps("meta", { action_source: "website" })).toEqual(["meta:website"]);
    expect(caps("meta", { action_source: "auto" })).toEqual(["meta", "meta:website"]);
    expect(caps("google", {})).toEqual(["google"]);
    expect(caps("google", { send_user_data: "with_consent" })).toEqual(["google", "google:enhanced"]);
    expect(caps("custom", {})).toEqual([]);
    for (const n of ["tiktok", "snapchat"]) {
      expect(caps(n, {})).toEqual([n]);
      expect(caps(n, { action_source: "website" })).toEqual([`${n}:website`]);
      expect(caps(n, { action_source: "auto" })).toEqual([n, `${n}:website`]);
    }
  });

  it("gives TikTok and Snap website events their own capability, apart from app events", () => {
    for (const provider of ["tiktok_ads", "snapchat_ads"]) {
      const c = connectorFor(provider)!;
      expect(c.eventDelivery.map((d) => [d.capability, d.actionSource])).toEqual([["conversions_outbound", "app"], ["web_conversions_outbound", "website"]]);
      const p = providerById(provider)!;
      const app = p.capabilities.find((x) => x.id === "conversions_outbound")!;
      const webCap = p.capabilities.find((x) => x.id === "web_conversions_outbound")!;
      expect(webCap.setupPath).toBe(app.setupPath);
      const network = provider === "tiktok_ads" ? "tiktok" : "snapchat";
      const pb = { postbacks: 1, active: 1, withCredentials: 1, lastSuccessAt: new Date("2026-10-01"), lastFailureAt: null, recentErrors: [], skipped: 0 };
      const only = { ...empty, postbacks: { [`${network}:website`]: pb } };
      expect(capabilityState(p, webCap, only).status).toBe("verified");
      expect(capabilityState(p, app, only).status).toBe("not_configured");
      expect(capabilityState(p, webCap, { ...empty, postbacks: { [`${network}:website`]: { ...pb, withCredentials: 0 } } }).status).toBe("credentials_missing");
    }
  });
});

describe("capability state of the new capabilities", () => {
  const pb = { postbacks: 1, active: 1, withCredentials: 1, lastSuccessAt: null, lastFailureAt: null, recentErrors: [], skipped: 0 };

  it("reports Meta website events and app events apart", () => {
    const p = providerById("meta_ads")!;
    const app = p.capabilities.find((c) => c.id === "conversions_outbound")!;
    const web = p.capabilities.find((c) => c.id === "web_conversions_outbound")!;
    const only = { ...empty, postbacks: { "meta:website": { ...pb, lastSuccessAt: new Date("2026-10-01") } } };
    expect(capabilityState(p, web, only).status).toBe("verified");
    // A website postback does not make app events look connected.
    expect(capabilityState(p, app, only).status).toBe("not_configured");
  });

  it("reports Google Enhanced Conversions only for postbacks that send user data", () => {
    const p = providerById("google_ads")!;
    const ec = p.capabilities.find((c) => c.id === "enhanced_conversions")!;
    expect(capabilityState(p, ec, { ...empty, postbacks: { google: pb } }).status).toBe("not_configured");
    expect(capabilityState(p, ec, { ...empty, postbacks: { google: pb, "google:enhanced": pb } }).status).toBe("unverified");
  });

  it("marks AdServices verified only after a real answer from Apple", () => {
    const p = providerById("apple_search_ads")!;
    const cap = p.capabilities[0];
    expect(capabilityState(p, cap, empty).status).toBe("not_configured");
    expect(capabilityState(p, cap, { ...empty, adservices: null }).status).toBeNull();
    const waiting = { total: 2, attributed: 0, lastAnswerAt: null, lastFailureAt: null, lastError: null };
    expect(capabilityState(p, cap, { ...empty, adservices: waiting }).status).toBe("unverified");
    expect(capabilityState(p, cap, { ...empty, adservices: { ...waiting, lastAnswerAt: new Date("2026-10-02") } }).status).toBe("verified");
    expect(capabilityState(p, cap, { ...empty, adservices: { ...waiting, lastAnswerAt: new Date("2026-10-01"), lastFailureAt: new Date("2026-10-02"), lastError: "Apple rejected the token as invalid" } })).toMatchObject({ status: "error", errors: [{ message: "Apple rejected the token as invalid" }] });
  });
});
