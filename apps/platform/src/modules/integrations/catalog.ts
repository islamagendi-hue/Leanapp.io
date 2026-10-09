import { msg } from "@/i18n/translate";
import type { Permission } from "@/modules/rbac/permissions";

/**
 * Every outside service LeanApp connects to, in one list, with where it is set up. `state` says
 * honestly how far each one is: live (in use), beta (built, not yet verified against the live
 * service) or soon (not built). Setup pages check their own permissions; `perm` only hides the
 * link from roles that couldn't open it.
 */
export type IntegrationState = "live" | "beta" | "soon";

export interface Integration {
  id: string;
  name: string;
  what: string;
  state: IntegrationState;
  /** Path under the project, e.g. "settings/dev-ops/webhooks". */
  path?: string;
  perm?: Permission;
}

export interface IntegrationGroup {
  title: string;
  items: Integration[];
}

export const INTEGRATIONS: IntegrationGroup[] = [
  {
    title: msg("Ad networks"),
    items: [
      { id: "meta", name: "Meta Ads", what: msg("Send installs and in-app events back to Meta (Facebook and Instagram) campaigns."), state: "beta", path: "settings/dev-ops/attribution/postbacks", perm: "attribution.read" },
      { id: "snap", name: "Snapchat Ads", what: msg("Send installs and in-app events back to Snapchat campaigns."), state: "beta", path: "settings/dev-ops/attribution/postbacks", perm: "attribution.read" },
      { id: "tiktok", name: "TikTok Ads", what: msg("Send installs and in-app events back to TikTok campaigns."), state: "beta", path: "settings/dev-ops/attribution/postbacks", perm: "attribution.read" },
      { id: "google-ads", name: "Google Ads", what: msg("Send conversions back to Google Ads app campaigns."), state: "beta", path: "settings/dev-ops/attribution/postbacks", perm: "attribution.read" },
      { id: "skan", name: "Apple SKAdNetwork", what: msg("Privacy-safe install measurement for iOS campaigns."), state: "beta", path: "settings/dev-ops/attribution/skan", perm: "attribution.read" },
    ],
  },
  {
    title: msg("Attribution and deep links"),
    items: [
      { id: "links", name: msg("Tracking links & QR"), what: msg("One link per campaign or influencer, with QR codes, that counts clicks and installs."), state: "beta", path: "acquisition/links", perm: "attribution.read" },
      { id: "deep-links", name: msg("Deep links"), what: msg("Open a specific screen in your app from a link, with app and universal link setup."), state: "beta", path: "settings/dev-ops/deep-links", perm: "deep_links.read" },
      { id: "custom-postback", name: msg("Custom postback URL"), what: msg("Send attributed installs and events to any URL you choose."), state: "live", path: "settings/dev-ops/attribution/postbacks", perm: "attribution.read" },
    ],
  },
  {
    title: msg("Messaging"),
    items: [
      { id: "whatsapp", name: "WhatsApp Business", what: msg("Send WhatsApp template messages from campaigns and flows (Meta Cloud API)."), state: "beta", path: "settings/dev-ops/channels", perm: "integrations.read" },
      { id: "push", name: msg("Push notifications"), what: msg("Firebase Cloud Messaging for Android and APNs for iOS."), state: "beta", path: "settings/dev-ops/channels", perm: "integrations.read" },
      { id: "email", name: msg("Email (Resend)"), what: msg("Send email from your own domain."), state: "beta", path: "settings/dev-ops/channels", perm: "integrations.read" },
    ],
  },
  {
    title: msg("Developers"),
    items: [
      { id: "api", name: msg("REST API and SDKs"), what: msg("Send events from your servers and apps, and read reports from your own tools."), state: "live", path: "settings/dev-ops/sdk", perm: "credentials.read" },
      { id: "webhooks", name: "Webhooks", what: msg("Get a signed HTTP call when an event, audience change or conversion happens."), state: "live", path: "settings/dev-ops/webhooks", perm: "webhooks.manage" },
    ],
  },
  {
    title: msg("Coming next"),
    items: [
      { id: "clarity", name: "Microsoft Clarity", what: msg("Open session recordings and heatmaps for the users in your reports."), state: "soon" },
      { id: "ad-spend", name: msg("Ad spend import"), what: msg("Bring in cost from Meta, Google, TikTok and Snap to see CPI and ROAS."), state: "soon" },
      { id: "ga4", name: "Google Analytics 4", what: msg("Send your events to GA4 as well."), state: "soon" },
      { id: "warehouse", name: msg("Data warehouse export"), what: msg("Copy your raw events to BigQuery or Snowflake."), state: "soon" },
    ],
  },
];
