/**
 * @leanapp/analytics: one SDK for attribution, product analytics and
 * automation events. See docs/sdk.md for the full guide.
 *
 *   import { Analytics } from "@leanapp/analytics";
 *   Analytics.initialize({ apiKey: "la_pk_dev_…" });
 *   Analytics.track("order_completed", { order_id: "o1", revenue: 45, currency: "SAR" });
 */
import { LeanAppClient, type AnalyticsOptions, type ConsentInput, type ConsentState, type FlushResult, type Properties } from "./client.js";
import type { Attribution } from "./attribution.js";

export { LeanAppClient, CONSENT_PURPOSES, DEFAULT_ENDPOINT, EXPOSURE_EVENT, SDK_NAME, SDK_VERSION, storagePrefix } from "./client.js";
export type { AnalyticsOptions, AppStateLike, ConsentInput, ExperimentAssignment, ConsentPurpose, ConsentState, ConsentStatus, FlushResult, Platform, Properties, WireEvent } from "./client.js";
export { ATTRIBUTION_PARAMS, parseAttribution, type Attribution } from "./attribution.js";
export { asyncStorageAdapter, localStorageAdapter, memoryStorage, type StorageAdapter } from "./storage.js";

let instance: LeanAppClient | null = null;
let warned = false;

function client(): LeanAppClient | null {
  if (!instance && !warned) {
    warned = true;
    console.warn("[LeanApp] Analytics.initialize() has not been called; events are ignored.");
  }
  return instance;
}

/** Process-wide singleton for apps. Servers handling many users can create their own LeanAppClient. */
export const Analytics = {
  initialize(options: AnalyticsOptions): LeanAppClient {
    if (instance) return instance;
    instance = new LeanAppClient(options);
    return instance;
  },
  track: (eventName: string, properties?: Properties, options?: { eventId?: string; timestamp?: Date }) => client()?.track(eventName, properties, options),
  screen: (screenName: string, properties?: Properties) => client()?.screen(screenName, properties),
  identify: (userId?: string | null, traits?: Properties) => client()?.identify(userId, traits),
  setUserProperties: (traits: Properties) => client()?.setUserProperties(traits),
  alias: (newUserId: string, previousId?: string) => client()?.alias(newUserId, previousId),
  registerPushToken: (token: string, provider: "fcm" | "apns", permission?: "granted" | "denied" | "provisional" | "unknown") =>
    client()?.registerPushToken(token, provider, permission),
  captureAttribution: (url: string): Attribution | null => client()?.captureAttribution(url) ?? null,
  getAttribution: () => client()?.getAttribution() ?? null,
  getAnonymousId: () => client()?.getAnonymousId() ?? null,
  getUserId: () => client()?.getUserId() ?? null,
  reset: () => client()?.reset(),
  optOut: () => client()?.optOut(),
  optIn: () => client()?.optIn(),
  setConsent: (consent: ConsentInput) => client()?.setConsent(consent),
  getConsent: (): ConsentState | null => client()?.getConsent() ?? null,
  /** The variant of a running experiment for the current user, or null (show your default). Sends the exposure event once. */
  getVariant: (experimentKey: string, options?: { expose?: boolean }): Promise<string | null> => client()?.getVariant(experimentKey, options) ?? Promise.resolve(null),
  trackExposure: (experimentKey: string, experimentId: string, variant: string) => client()?.trackExposure(experimentKey, experimentId, variant),
  flush: (): Promise<FlushResult> => client()?.flush() ?? Promise.resolve({ status: "empty" as const }),
  /** For tests: drops the singleton. */
  async _reset(): Promise<void> {
    await instance?.shutdown();
    instance = null;
    warned = false;
  },
};

export default Analytics;
