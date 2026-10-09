import { msg } from "@/i18n/translate";
import { CONVERSION_NETWORK, isAdProvider, type CapabilityDescriptor, type ProviderDescriptor } from "./registry";
import type { CapabilityStatus } from "./status";

/**
 * What the Integrations Center shows for one capability of one provider,
 * derived from the real records each part of LeanApp keeps (connections,
 * postback deliveries, messaging integrations, webhook deliveries, SKAN
 * postbacks, keys). Pure; unit-tested in center.test.ts. `null` status means
 * the viewer's role can't see that part.
 */
export interface CapabilityState {
  status: CapabilityStatus | null;
  /** Why, when the status alone doesn't say (msg-marked or provider text). */
  detail: string | null;
  lastSuccessAt: Date | null;
  /** Inbound only: last day fully imported. */
  freshThrough: string | null;
  errors: { at: Date | null; message: string; code?: string | null }[];
}

/** The subset of service.CenterData this needs (kept structural so it stays pure). */
export interface CenterInput {
  connections: {
    provider: string;
    capabilities: { capability: string; status: CapabilityStatus; status_detail: string | null; last_success_at: Date | null; last_error_at: Date | null; last_error: string | null; data_fresh_through: string | null }[];
  }[];
  postbacks: Record<string, { postbacks: number; active: number; withCredentials: number; lastSuccessAt: Date | null; lastFailureAt: Date | null; recentErrors: { at: Date; error: string; code: string | null }[]; skipped: number }> | null;
  /** Apple AdServices lookups (null when the role can't see attribution). Optional for callers that predate it. */
  adservices?: { total: number; attributed: number; lastAnswerAt: Date | null; lastFailureAt: Date | null; lastError: string | null } | null;
  messaging: { provider: string; status: string; last_error: string | null; last_used_at: Date | null; live_verified_at: Date | null }[] | null;
  webhooks: { total: number; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastError: string | null } | null;
  skan: { received: number; lastAt: Date | null } | null;
  links: { links: number; lastClickAt: Date | null } | null;
  deepLinks: { configured: boolean; lastCheckedAt: Date | null } | null;
  sdk: { lastUsedAt: Date | null; activeKeys: number } | null;
  paymentsConnected: boolean | null;
}

/**
 * The key postback status is grouped under for an outbound capability (see
 * service.ts POSTBACK_KEYS_SQL): Meta website events and Google Enhanced
 * Conversions are reported apart from the network's other deliveries.
 */
export function postbackKey(network: string, capability: CapabilityDescriptor["id"]): string {
  if (capability === "web_conversions_outbound") return `${network}:website`;
  if (capability === "enhanced_conversions") return `${network}:enhanced`;
  return network;
}

const empty = (status: CapabilityStatus | null, detail: string | null = null): CapabilityState => ({ status, detail, lastSuccessAt: null, freshThrough: null, errors: [] });
const t = (d: Date | null) => (d ? new Date(d).getTime() : 0);

/** Status of something judged by its last success and last failure. */
function bySuccessAndFailure(lastSuccess: Date | null, lastFailure: Date | null, lastError: string | null, base: CapabilityStatus = "unverified"): CapabilityState {
  const failed = t(lastFailure) > t(lastSuccess);
  return {
    status: failed ? "error" : lastSuccess ? "verified" : base,
    detail: null,
    lastSuccessAt: lastSuccess,
    freshThrough: null,
    errors: failed && lastError ? [{ at: lastFailure, message: lastError }] : [],
  };
}

export function capabilityState(provider: ProviderDescriptor, cap: CapabilityDescriptor, d: CenterInput): CapabilityState {
  switch (cap.id) {
    case "ad_reporting":
    case "spend_import": {
      const row = d.connections.find((c) => c.provider === provider.id)?.capabilities.find((c) => c.capability === cap.id);
      if (!row) return empty("not_configured");
      return {
        status: row.status,
        detail: row.status_detail,
        lastSuccessAt: row.last_success_at,
        freshThrough: row.data_fresh_through,
        errors: row.last_error && row.status === "error" ? [{ at: row.last_error_at, message: row.last_error }] : [],
      };
    }
    case "conversions_outbound":
    case "web_conversions_outbound":
    case "enhanced_conversions":
    case "custom_postbacks": {
      if (!d.postbacks) return empty(null);
      const network = cap.id === "custom_postbacks" ? "custom" : isAdProvider(provider.id) ? postbackKey(CONVERSION_NETWORK[provider.id], cap.id) : null;
      const p = network ? d.postbacks[network] : undefined;
      if (!p || p.active === 0) return empty("not_configured");
      if (network !== "custom" && p.withCredentials === 0) return empty("credentials_missing");
      const s = bySuccessAndFailure(p.lastSuccessAt, p.lastFailureAt, null);
      return { ...s, errors: s.status === "error" ? p.recentErrors.map((e) => ({ at: e.at, message: e.error, code: e.code })) : [] };
    }
    case "adservices_attribution": {
      if (d.adservices === undefined || d.adservices === null) return empty(null);
      const a = d.adservices;
      if (!a.total) return empty("not_configured", msg("No AdServices token received in the last 30 days."));
      // Verified only by a real answer from Apple (attributed or not); tokens still waiting for Apple stay unverified.
      return bySuccessAndFailure(a.lastAnswerAt, a.lastFailureAt, a.lastError);
    }
    case "skan_postbacks":
      if (!d.skan) return empty(null);
      return d.skan.received ? { ...empty("verified"), lastSuccessAt: d.skan.lastAt } : empty("not_configured");
    case "tracking_links":
      if (!d.links) return empty(null);
      if (!d.links.links) return empty("not_configured");
      return d.links.lastClickAt ? { ...empty("verified"), lastSuccessAt: d.links.lastClickAt } : empty("unverified");
    case "deep_links":
      if (!d.deepLinks) return empty(null);
      if (!d.deepLinks.configured) return empty("not_configured");
      return d.deepLinks.lastCheckedAt ? { ...empty("verified"), lastSuccessAt: d.deepLinks.lastCheckedAt } : empty("unverified");
    case "event_ingestion":
      if (!d.sdk) return empty(null);
      if (d.sdk.lastUsedAt) return { ...empty("verified"), lastSuccessAt: d.sdk.lastUsedAt };
      return empty(d.sdk.activeKeys ? "unverified" : "not_configured");
    case "push_delivery":
    case "email_delivery":
    case "whatsapp_delivery": {
      if (!d.messaging) return empty(null);
      const row = d.messaging.find((m) => m.provider === provider.id);
      if (!row) return empty("not_configured");
      if (row.status === "disabled") return empty("not_configured");
      if (row.last_error) return { ...empty("error"), lastSuccessAt: row.live_verified_at, errors: [{ at: row.last_used_at, message: row.last_error }] };
      return row.live_verified_at ? { ...empty("verified"), lastSuccessAt: row.last_used_at ?? row.live_verified_at } : empty("unverified");
    }
    case "webhook_delivery":
      if (!d.webhooks) return empty(null);
      if (!d.webhooks.total) return empty("not_configured");
      return bySuccessAndFailure(d.webhooks.lastSuccessAt, d.webhooks.lastFailureAt, d.webhooks.lastError);
    case "plan_billing":
      if (d.paymentsConnected === null) return empty(null);
      // Configured by server keys; LeanApp doesn't call Stripe just to show this page.
      return d.paymentsConnected ? empty("unverified", msg("Keys are set on the server; checked when a payment runs.")) : empty("not_configured");
  }
}
