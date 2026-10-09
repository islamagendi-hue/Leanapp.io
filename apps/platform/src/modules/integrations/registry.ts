import { msg } from "@/i18n/translate";
import type { Permission } from "@/modules/rbac/permissions";

/**
 * The Integrations Center registry: every provider LeanApp knows, the
 * category it is shown under, and the capabilities it offers. Pure and
 * client-safe; nothing here says whether anything is connected. Status is per
 * capability and comes from the database (see ./status.ts and ./service.ts).
 *
 * Concepts (docs/integrations.md):
 *   provider      a company / API (Meta, Google Ads, Resend…)
 *   data source   a provider with at least one inbound capability (we read from it)
 *   service provider  a provider with at least one outbound capability (we send to it)
 *   capability    one thing we do with a provider, inbound or outbound, set up and
 *                 reported on its own: connecting Meta's Conversions API does not
 *                 import Meta ad costs, and the other way round.
 *
 * `implementation`:
 *   built         code exists in LeanApp and runs when configured (verification
 *                 against the live provider is shown per capability, not here)
 *   descriptor    known official API, not built; shown without any setup action
 */
export type CategoryId = "advertising" | "analytics" | "attribution" | "messaging" | "crm" | "commerce" | "webhooks" | "billing";

export const CATEGORIES: { id: CategoryId; title: string; blurb: string }[] = [
  { id: "advertising", title: msg("Advertising Platforms"), blurb: msg("Import ad accounts, campaigns, costs and results, and send conversions back to the networks.") },
  { id: "analytics", title: msg("Analytics and Event Sources"), blurb: msg("Where your events come from, and where they can be sent.") },
  { id: "attribution", title: msg("Attribution and Deep Links"), blurb: msg("Tracking links, deep links, SKAdNetwork and postbacks.") },
  { id: "messaging", title: msg("Messaging Providers"), blurb: msg("Push, email and WhatsApp delivery through your own provider accounts.") },
  { id: "crm", title: msg("CRM and Customer Data"), blurb: msg("Sync users and audiences with your customer systems.") },
  { id: "commerce", title: msg("Commerce and Revenue Sources"), blurb: msg("Purchases and subscription revenue from stores and payment systems.") },
  { id: "webhooks", title: msg("Webhooks and Custom Integrations"), blurb: msg("Signed HTTP calls and the REST API, for anything not listed here.") },
  { id: "billing", title: msg("Billing and Payments"), blurb: msg("How this LeanApp workspace pays for its plan.") },
];

export type CapabilityId =
  | "ad_reporting"
  | "spend_import"
  | "conversions_outbound"
  | "skan_postbacks"
  | "tracking_links"
  | "deep_links"
  | "custom_postbacks"
  | "event_ingestion"
  | "push_delivery"
  | "email_delivery"
  | "whatsapp_delivery"
  | "webhook_delivery"
  | "plan_billing";

export type Direction = "inbound" | "outbound";

export interface CapabilityDescriptor {
  id: CapabilityId;
  direction: Direction;
  title: string;
  description: string;
  /** What has to be in place before it can work. */
  requirements: string[];
  /** Provider-side permissions (OAuth scopes / roles) the credentials need. */
  providerPermissions: string[];
  /** Where it is set up, under the project; absent for descriptor-only providers. */
  setupPath?: string;
  /** LeanApp permission needed to open the setup page. */
  perm?: Permission;
  /** setupPath is under the organization, not the project. */
  orgLevel?: boolean;
}

export interface ProviderDescriptor {
  id: string;
  name: string;
  category: CategoryId;
  implementation: "built" | "descriptor";
  /** Official API documentation. */
  docsUrl?: string;
  capabilities: CapabilityDescriptor[];
  /** Short note shown on descriptor-only cards. */
  note?: string;
}

export const AD_PROVIDERS = ["meta_ads", "google_ads", "tiktok_ads", "snapchat_ads"] as const;
export type AdProvider = (typeof AD_PROVIDERS)[number];
export const isAdProvider = (v: string): v is AdProvider => (AD_PROVIDERS as readonly string[]).includes(v);

/** The postback network that carries each ad provider's outbound conversions (modules/attribution/networks). */
export const CONVERSION_NETWORK: Record<AdProvider, "meta" | "google" | "tiktok" | "snapchat"> = {
  meta_ads: "meta",
  google_ads: "google",
  tiktok_ads: "tiktok",
  snapchat_ads: "snapchat",
};

const integrationPage = (provider: string) => `settings/integrations/${provider}`;
const postbacks = "settings/dev-ops/attribution/postbacks";

function adCapabilities(provider: AdProvider, reportingPerms: string[], conversions: { title: string; perms: string[]; requirements: string[] }): CapabilityDescriptor[] {
  return [
    {
      id: "ad_reporting", direction: "inbound", title: msg("Ad reporting import"),
      description: msg("Daily ad accounts, campaigns, ad sets, ads, impressions, clicks, spend and conversions, with their external ids."),
      requirements: [msg("Credentials with read access to the ad accounts"), msg("At least one ad account chosen")],
      providerPermissions: reportingPerms, setupPath: integrationPage(provider), perm: "integrations.read",
    },
    {
      id: "spend_import", direction: "inbound", title: msg("Cost import into Ad spend"),
      description: msg("Writes the imported daily cost per campaign into Ad spend, so ROAS and cost per install use it. Amounts you entered by hand are never overwritten."),
      requirements: [msg("Ad reporting import working")],
      providerPermissions: reportingPerms, setupPath: integrationPage(provider), perm: "integrations.read",
    },
    {
      id: "conversions_outbound", direction: "outbound", title: conversions.title,
      description: msg("Sends attributed installs and conversions to the network, with event ids for deduplication, consent checks and a delivery log."),
      requirements: conversions.requirements,
      providerPermissions: conversions.perms, setupPath: postbacks, perm: "attribution.read",
    },
  ];
}

export const PROVIDERS: ProviderDescriptor[] = [
  // ── Advertising ──────────────────────────────────────────────────────────
  {
    id: "meta_ads", name: "Meta Ads", category: "advertising", implementation: "built",
    docsUrl: "https://developers.facebook.com/docs/marketing-api/insights",
    capabilities: adCapabilities("meta_ads", ["ads_read"], {
      title: msg("Meta Conversions API"), perms: [msg("Dataset access token")],
      requirements: [msg("Dataset (app) ID"), msg("Conversions API access token")],
    }),
  },
  {
    id: "google_ads", name: "Google Ads", category: "advertising", implementation: "built",
    docsUrl: "https://developers.google.com/google-ads/api/docs/start",
    capabilities: adCapabilities("google_ads", ["https://www.googleapis.com/auth/adwords"], {
      title: msg("Google Ads click conversions"), perms: ["https://www.googleapis.com/auth/adwords"],
      requirements: [msg("Customer ID and conversion action"), msg("Developer token and OAuth refresh token")],
    }),
  },
  {
    id: "tiktok_ads", name: "TikTok Ads", category: "advertising", implementation: "built",
    docsUrl: "https://business-api.tiktok.com/portal/docs",
    capabilities: adCapabilities("tiktok_ads", [msg("Ads management: read reports")], {
      title: msg("TikTok Events API"), perms: [msg("Events API access token")],
      requirements: [msg("TikTok App ID"), msg("Events API access token")],
    }),
  },
  {
    id: "snapchat_ads", name: "Snapchat Ads", category: "advertising", implementation: "built",
    docsUrl: "https://developers.snap.com/api/marketing-api/Ads-API/introduction",
    capabilities: adCapabilities("snapchat_ads", ["snapchat-marketing-api"], {
      title: msg("Snap Conversions API"), perms: [msg("Conversions API token")],
      requirements: [msg("Snap App ID"), msg("Conversions API token")],
    }),
  },
  {
    id: "apple_skan", name: "Apple SKAdNetwork", category: "attribution", implementation: "built",
    docsUrl: "https://developer.apple.com/documentation/storekit/skadnetwork",
    capabilities: [{
      id: "skan_postbacks", direction: "inbound", title: msg("SKAdNetwork postbacks"),
      description: msg("Developer copies of Apple's install postbacks, decoded with your conversion value schema."),
      requirements: [msg("NSAdvertisingAttributionReportEndpoint set in the iOS app")], providerPermissions: [],
      setupPath: "settings/dev-ops/attribution/skan", perm: "attribution.read",
    }],
  },
  // Descriptor-only advertising providers: official APIs exist; LeanApp does not call them yet.
  { id: "linkedin_ads", name: "LinkedIn Ads", category: "advertising", implementation: "descriptor", docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/", capabilities: [], note: msg("Reporting API documented by the provider; not built in LeanApp.") },
  { id: "microsoft_ads", name: "Microsoft Advertising", category: "advertising", implementation: "descriptor", docsUrl: "https://learn.microsoft.com/en-us/advertising/guides/", capabilities: [], note: msg("Reporting API documented by the provider; not built in LeanApp.") },
  { id: "x_ads", name: "X Ads", category: "advertising", implementation: "descriptor", docsUrl: "https://developer.x.com/en/docs/x-ads-api", capabilities: [], note: msg("Reporting API documented by the provider; not built in LeanApp.") },
  { id: "pinterest_ads", name: "Pinterest Ads", category: "advertising", implementation: "descriptor", docsUrl: "https://developers.pinterest.com/docs/api/v5/", capabilities: [], note: msg("Reporting API documented by the provider; not built in LeanApp.") },

  // ── Analytics and event sources ─────────────────────────────────────────
  {
    id: "leanapp_sdk", name: msg("LeanApp SDKs and REST API"), category: "analytics", implementation: "built",
    capabilities: [{
      id: "event_ingestion", direction: "inbound", title: msg("Event ingestion"),
      description: msg("Events from your apps (SDK key) and servers (secret key)."),
      requirements: [msg("An SDK key in the app or a secret key on the server")], providerPermissions: [],
      setupPath: "settings/dev-ops/sdk", perm: "credentials.read",
    }],
  },
  { id: "ga4", name: "Google Analytics 4", category: "analytics", implementation: "descriptor", docsUrl: "https://developers.google.com/analytics/devguides/collection/protocol/ga4", capabilities: [], note: msg("Not built in LeanApp.") },

  // ── Attribution and deep links ──────────────────────────────────────────
  {
    id: "leanapp_links", name: msg("Tracking links and deep links"), category: "attribution", implementation: "built",
    capabilities: [
      { id: "tracking_links", direction: "inbound", title: msg("Tracking links and QR"), description: msg("Clicks and installs per campaign link."), requirements: [], providerPermissions: [], setupPath: "acquisition/links", perm: "attribution.read" },
      { id: "deep_links", direction: "outbound", title: msg("Deep links"), description: msg("App Links and Universal Links that open a screen in your app."), requirements: [msg("Domain verification files served")], providerPermissions: [], setupPath: "settings/dev-ops/deep-links", perm: "deep_links.read" },
      { id: "custom_postbacks", direction: "outbound", title: msg("Custom postback URL"), description: msg("Attributed installs and events sent to a URL you choose."), requirements: [], providerPermissions: [], setupPath: postbacks, perm: "attribution.read" },
    ],
  },

  // ── Messaging (owned by the messaging workstream; see messagingDescriptors) ──
  ...messagingDescriptors(),

  // ── CRM / commerce: nothing built yet ───────────────────────────────────
  { id: "hubspot", name: "HubSpot", category: "crm", implementation: "descriptor", docsUrl: "https://developers.hubspot.com/docs/api/overview", capabilities: [], note: msg("Not built in LeanApp.") },
  { id: "app_store_server", name: "App Store Server Notifications", category: "commerce", implementation: "descriptor", docsUrl: "https://developer.apple.com/documentation/appstoreservernotifications", capabilities: [], note: msg("Not built in LeanApp. Send purchases as events from your server in the meantime.") },
  { id: "google_play_rtdn", name: "Google Play Real-time developer notifications", category: "commerce", implementation: "descriptor", docsUrl: "https://developer.android.com/google/play/billing/getting-ready#configure-rtdn", capabilities: [], note: msg("Not built in LeanApp. Send purchases as events from your server in the meantime.") },

  // ── Webhooks ────────────────────────────────────────────────────────────
  {
    id: "leanapp_webhooks", name: "Webhooks", category: "webhooks", implementation: "built",
    capabilities: [{
      id: "webhook_delivery", direction: "outbound", title: msg("Signed webhooks"),
      description: msg("A signed HTTP call whenever an event, audience change or conversion happens."),
      requirements: [msg("An https endpoint that checks the signature")], providerPermissions: [],
      setupPath: "settings/dev-ops/webhooks", perm: "webhooks.manage",
    }],
  },

  // ── Billing ─────────────────────────────────────────────────────────────
  {
    id: "stripe_billing", name: "Stripe", category: "billing", implementation: "built",
    docsUrl: "https://docs.stripe.com/api",
    capabilities: [{
      id: "plan_billing", direction: "outbound", title: msg("Plan payments"),
      description: msg("Pays for this workspace's LeanApp plan. Configured by the LeanApp operator, not per project."),
      requirements: [msg("STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET on the server")], providerPermissions: [],
      setupPath: "settings/billing", orgLevel: true, perm: "billing.read",
    }],
  },
];

/**
 * Messaging providers. HOOK for the messaging workstream: when its provider
 * registry (modules/messaging/providers/registry.ts, MESSAGING_PROVIDERS)
 * lands, map it here instead of these minimal entries. Status comes from
 * platform.integrations rows of any provider (see service.ts).
 */
export function messagingDescriptors(): ProviderDescriptor[] {
  const channels = "settings/dev-ops/channels";
  const cap = (id: CapabilityId, title: string, description: string, requirements: string[]): CapabilityDescriptor => ({
    id, direction: "outbound", title, description, requirements, providerPermissions: [], setupPath: channels, perm: "integrations.read",
  });
  return [
    { id: "fcm", name: "Firebase Cloud Messaging", category: "messaging", implementation: "built", docsUrl: "https://firebase.google.com/docs/cloud-messaging", capabilities: [cap("push_delivery", msg("Android push"), msg("Push messages to Android devices."), [msg("Service account JSON")])] },
    { id: "apns", name: "Apple Push Notification service", category: "messaging", implementation: "built", docsUrl: "https://developer.apple.com/documentation/usernotifications", capabilities: [cap("push_delivery", msg("iOS push"), msg("Push messages to iOS devices."), [msg(".p8 auth key, Key ID, Team ID and bundle ID")])] },
    { id: "resend", name: "Resend", category: "messaging", implementation: "built", docsUrl: "https://resend.com/docs/api-reference/introduction", capabilities: [cap("email_delivery", msg("Email"), msg("Campaign and flow emails from your own domain."), [msg("Resend API key and verified sender")])] },
    { id: "whatsapp", name: "WhatsApp Business (Cloud API)", category: "messaging", implementation: "built", docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api", capabilities: [cap("whatsapp_delivery", msg("WhatsApp templates"), msg("Template messages from campaigns and flows."), [msg("Phone number ID, WABA ID, access token and app secret")])] },
  ];
}

export function providerById(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** A provider is a data source when it has an inbound capability, a service provider when it has an outbound one. */
export function providerRoles(p: ProviderDescriptor): ("data_source" | "service_provider")[] {
  const roles: ("data_source" | "service_provider")[] = [];
  if (p.capabilities.some((c) => c.direction === "inbound")) roles.push("data_source");
  if (p.capabilities.some((c) => c.direction === "outbound")) roles.push("service_provider");
  return roles;
}
