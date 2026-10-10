/**
 * What deep links do for one environment today, stated honestly for the business
 * page (Acquisition → Deep links). The technical setup lives in Settings → Dev Ops
 * → Deep link setup; this only reads its result. Pure and client-safe.
 */

import { msg } from "@/i18n/translate";

export type CapabilityStatus = "live" | "beta" | "unverified" | "needs_setup" | "off";

export interface Capability {
  key: "fallback" | "ios" | "android" | "campaign" | "deferred";
  label: string;
  status: CapabilityStatus;
  detail: string;
}

export const CAPABILITY_STATUS_LABELS: Record<CapabilityStatus, string> = {
  live: msg("Live"),
  beta: msg("Beta"),
  unverified: msg("Not verified"),
  needs_setup: msg("Needs setup"),
  off: msg("Off"),
};

interface ConfigFacts {
  ios_team_id: string | null;
  ios_bundle_ids: string[];
  android_package: string | null;
  android_sha256: string[];
  deferred_enabled: boolean;
  last_check: { file: string; ok: boolean; warning?: boolean }[] | null;
}

const checked = (config: ConfigFacts, file: string) => config.last_check?.find((c) => c.file === file && !c.warning) ?? null;

/** The three not-live states' details, one full sentence per platform so each translates whole. */
interface AssociationText { needsSetup: string; unverified: string; failed: string }

function association(config: ConfigFacts | null, configured: boolean, file: string, text: AssociationText): Pick<Capability, "status" | "detail"> {
  if (!config || !configured) return { status: "needs_setup", detail: text.needsSetup };
  const c = checked(config, file);
  if (!c) return { status: "unverified", detail: text.unverified };
  if (!c.ok) return { status: "unverified", detail: text.failed };
  return { status: "live", detail: msg("Opens the installed app from the link. To land on the link's screen your app sends the opened URL to GET /v1/deep-links/resolve; the LeanApp SDKs don't make this call yet.") };
}

const IOS_TEXT: AssociationText = {
  needsSetup: msg("Add the iOS app details in Deep link setup. Until then links go to the store even when the app is installed."),
  unverified: msg("Configured. Run the check in Deep link setup to confirm apple-app-site-association is served correctly."),
  failed: msg("The last check of apple-app-site-association failed. See Deep link setup."),
};
const ANDROID_TEXT: AssociationText = {
  needsSetup: msg("Add the Android app details in Deep link setup. Until then links go to the store even when the app is installed."),
  unverified: msg("Configured. Run the check in Deep link setup to confirm assetlinks.json is served correctly."),
  failed: msg("The last check of assetlinks.json failed. See Deep link setup."),
};

export function deepLinkCapabilities(config: ConfigFacts | null): Capability[] {
  const ios = association(config, Boolean(config?.ios_team_id && config.ios_bundle_ids.length), "apple-app-site-association", IOS_TEXT);
  const android = association(config, Boolean(config?.android_package && config.android_sha256.length), "assetlinks.json", ANDROID_TEXT);
  return [
    { key: "fallback", label: msg("Store and web fallback"), status: "live", detail: msg("People without the app go to the App Store, Google Play or your web page. Crawlers and link previews are not counted.") },
    { key: "ios", label: msg("Open the app on iOS (Universal Links)"), ...ios },
    { key: "android", label: msg("Open the app on Android (App Links)"), ...android },
    {
      key: "campaign",
      label: msg("Campaign data on app opens"),
      status: "live",
      detail: msg("The Android SDK reads the opened link automatically; on iOS and Flutter your app passes the URL to captureAttribution(). Later events carry the link's campaign, and the open counts as a re-engagement."),
    },
    {
      key: "deferred",
      label: msg("Deep link after install (deferred)"),
      ...(!config
        ? { status: "needs_setup" as const, detail: msg("Set up deep links first.") }
        : !config.deferred_enabled
          ? { status: "off" as const, detail: msg("Turned off in Deep link setup.") }
          : {
              status: "beta" as const,
              detail: msg("The LeanApp SDKs ask POST /v1/deep-links/deferred once on a new install's first open, after attribution consent, and hand the returned deep link to your app. Exact match on Android through the Play install referrer; on iOS only when your app passes the click id."),
            }),
    },
  ];
}
