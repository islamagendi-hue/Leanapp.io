import type { Network } from "@/modules/attribution/networks";
import type { AdProvider, CapabilityId } from "./registry";

/**
 * The provider-agnostic connector architecture: one entry per provider
 * LeanApp has code for, made of independent parts. Each part is set up,
 * permissioned, verified and reported on its own (capability-level status in
 * the Integrations Center), so connecting one never turns on another:
 *
 *   auth               how credentials are obtained: LeanApp's OAuth app ("oauth",
 *                      when the operator configured it), credentials the customer
 *                      pastes ("manual"), or none needed ("none")
 *   costImport         inbound ad accounts, campaigns and daily cost
 *                      (an AdAdapter in ./ads, driven by ./sync.ts)
 *   eventDelivery      outbound conversions, each destination a postback network
 *                      plus the postback settings that select it
 *                      (modules/attribution/networks.ts, delivery.ts)
 *   attributionLookup  inbound provider-reported attribution for an install
 *                      (modules/attribution/adservices.ts)
 *
 * No part decides attribution. Cost import writes spend; event delivery sends
 * events the attribution engine (modules/attribution/engine.ts) has already
 * attributed and queued; an attribution lookup stores what the provider
 * reports, which the engine may read as evidence. LeanApp's own analytics and
 * attribution work with no connector at all.
 *
 * Adding a provider (TikTok and Snapchat follow this shape): an AdAdapter for
 * cost import, a network in NETWORKS for delivery, its capabilities in
 * ./registry.ts, and an entry here. connectors.test.ts checks the three agree.
 */
export type AuthMethod = "oauth" | "manual" | "none";

export interface EventDestination {
  capability: CapabilityId;
  network: Network;
  /** Postback settings (attribution_postbacks.config) that route deliveries to this destination; {} = the network's default. */
  settings: Record<string, string[]>;
  /** Where the provider expects the event to have happened. */
  actionSource: "app" | "website" | "any";
}

export interface Connector {
  provider: string;
  auth: { methods: AuthMethod[]; oauthScopes: string[] };
  /** Key into AD_ADAPTERS, or null when the provider has no cost import. */
  costImport: AdProvider | null;
  eventDelivery: EventDestination[];
  attributionLookup: "apple_adservices" | null;
}

export const CONNECTORS: Connector[] = [
  {
    provider: "meta_ads",
    auth: { methods: ["oauth", "manual"], oauthScopes: ["ads_read"] },
    costImport: "meta_ads",
    eventDelivery: [
      { capability: "conversions_outbound", network: "meta", settings: { action_source: ["app", "auto"] }, actionSource: "app" },
      { capability: "web_conversions_outbound", network: "meta", settings: { action_source: ["website", "auto"] }, actionSource: "website" },
    ],
    attributionLookup: null,
  },
  {
    provider: "google_ads",
    auth: { methods: ["oauth", "manual"], oauthScopes: ["https://www.googleapis.com/auth/adwords"] },
    costImport: "google_ads",
    eventDelivery: [
      { capability: "conversions_outbound", network: "google", settings: {}, actionSource: "any" },
      { capability: "enhanced_conversions", network: "google", settings: { send_user_data: ["with_consent", "unless_denied"] }, actionSource: "any" },
    ],
    attributionLookup: null,
  },
  {
    provider: "tiktok_ads",
    auth: { methods: ["oauth", "manual"], oauthScopes: [] },
    costImport: "tiktok_ads",
    eventDelivery: [
      { capability: "conversions_outbound", network: "tiktok", settings: { action_source: ["app", "auto"] }, actionSource: "app" },
      { capability: "web_conversions_outbound", network: "tiktok", settings: { action_source: ["website", "auto"] }, actionSource: "website" },
    ],
    attributionLookup: null,
  },
  {
    provider: "snapchat_ads",
    auth: { methods: ["oauth", "manual"], oauthScopes: ["snapchat-marketing-api"] },
    costImport: "snapchat_ads",
    eventDelivery: [
      { capability: "conversions_outbound", network: "snapchat", settings: { action_source: ["app", "auto"] }, actionSource: "app" },
      { capability: "web_conversions_outbound", network: "snapchat", settings: { action_source: ["website", "auto"] }, actionSource: "website" },
    ],
    attributionLookup: null,
  },
  {
    provider: "apple_search_ads",
    auth: { methods: ["none"], oauthScopes: [] },
    costImport: null,
    eventDelivery: [],
    attributionLookup: "apple_adservices",
  },
];

export function connectorFor(provider: string): Connector | undefined {
  return CONNECTORS.find((c) => c.provider === provider);
}

/** The registry capabilities a connector implements, in registry order of kinds. */
export function connectorCapabilities(c: Connector): CapabilityId[] {
  const caps: CapabilityId[] = [];
  if (c.costImport) caps.push("ad_reporting", "spend_import");
  for (const d of c.eventDelivery) caps.push(d.capability);
  if (c.attributionLookup === "apple_adservices") caps.push("adservices_attribution");
  return caps;
}

/** The delivery destinations one postback feeds, from its network and settings. */
export function destinationsOf(network: string, config: Record<string, string>): EventDestination[] {
  return CONNECTORS.flatMap((c) => c.eventDelivery).filter((d) => {
    if (d.network !== network) return false;
    return Object.entries(d.settings).every(([key, values]) => values.includes(config[key] ?? (key === "action_source" ? "app" : "off")));
  });
}
