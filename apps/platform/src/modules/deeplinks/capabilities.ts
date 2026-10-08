/**
 * What deep links do for one environment today, stated honestly for the business
 * page (Acquisition → Deep links). The technical setup lives in Settings → Dev Ops
 * → Deep link setup; this only reads its result. Pure and client-safe.
 */

export type CapabilityStatus = "live" | "beta" | "unverified" | "needs_setup" | "off";

export interface Capability {
  key: "fallback" | "ios" | "android" | "campaign" | "deferred";
  label: string;
  status: CapabilityStatus;
  detail: string;
}

export const CAPABILITY_STATUS_LABELS: Record<CapabilityStatus, string> = {
  live: "Live",
  beta: "Beta",
  unverified: "Not verified",
  needs_setup: "Needs setup",
  off: "Off",
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

function association(config: ConfigFacts | null, configured: boolean, file: string, platform: string): Pick<Capability, "status" | "detail"> {
  if (!config || !configured) return { status: "needs_setup", detail: `Add the ${platform} app details in Deep link setup. Until then links go to the store even when the app is installed.` };
  const c = checked(config, file);
  if (!c) return { status: "unverified", detail: `Configured. Run the check in Deep link setup to confirm ${file} is served correctly.` };
  if (!c.ok) return { status: "unverified", detail: `The last check of ${file} failed. See Deep link setup.` };
  return { status: "live", detail: "Opens the installed app from the link. To land on the link's screen your app sends the opened URL to POST /v1/deep-links/resolve; the LeanApp SDKs don't make this call yet." };
}

export function deepLinkCapabilities(config: ConfigFacts | null): Capability[] {
  const ios = association(config, Boolean(config?.ios_team_id && config.ios_bundle_ids.length), "apple-app-site-association", "iOS");
  const android = association(config, Boolean(config?.android_package && config.android_sha256.length), "assetlinks.json", "Android");
  return [
    { key: "fallback", label: "Store and web fallback", status: "live", detail: "People without the app go to the App Store, Google Play or your web page. Crawlers and link previews are not counted." },
    { key: "ios", label: "Open the app on iOS (Universal Links)", ...ios },
    { key: "android", label: "Open the app on Android (App Links)", ...android },
    {
      key: "campaign",
      label: "Campaign data on app opens",
      status: "live",
      detail: "The Android SDK reads the opened link automatically; on iOS and Flutter your app passes the URL to captureAttribution(). Later events carry the link's campaign, and the open counts as a re-engagement.",
    },
    {
      key: "deferred",
      label: "Deep link after install (deferred)",
      ...(!config
        ? { status: "needs_setup" as const, detail: "Set up deep links first." }
        : !config.deferred_enabled
          ? { status: "off" as const, detail: "Turned off in Deep link setup." }
          : {
              status: "beta" as const,
              detail: "API only: your app calls POST /v1/deep-links/deferred on its first open and routes to the returned deep link. The LeanApp SDKs don't make this call yet. Exact match on Android through the Play install referrer; on iOS only when your app passes the click id.",
            }),
    },
  ];
}
