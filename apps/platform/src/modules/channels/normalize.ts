/**
 * Normalising touch parameters (UTMs, click ids, referral ids, custom
 * dimensions) from any of the places LeanApp sees them: a tracking-link URL,
 * an SDK's context.attribution / context.campaign, an install referrer, a
 * stored touchpoint. Pure and client-safe; unit-tested in normalize.test.ts.
 *
 * The raw parameters are always kept next to the normalised ones, so a
 * changed rule can be re-applied and nothing the sender wrote is lost.
 */
import { CLICK_ID_CHANNELS, compact } from "./registry";

export { compact };

export interface NormalizedTouch {
  /** Lower case, trimmed, spaces → "_", at most 100 characters. */
  source: string | null;
  medium: string | null;
  /** Campaign name as sent (trimmed), and its id when the sender passed one (utm_id, campaign_id). */
  campaign: string | null;
  campaignId: string | null;
  content: string | null;
  term: string | null;
  /** Ad-network click ids found, by parameter name (canonical case: ScCid). */
  clickIds: Record<string, string>;
  /** Referral program / invite id (ref, referral_code, invite_code, referrer_id). */
  referralId: string | null;
  /** Hostname of the referring page, lower case, without "www.". */
  referrerHost: string | null;
  /** Customer dimensions: other utm_* keys and keys prefixed cd_ or custom_ (at most 20). */
  custom: Record<string, string>;
  /** Every parameter as received (strings only, at most 50 keys of 500 characters). */
  raw: Record<string, string>;
}

const MAX = 100;
const ALIASES = {
  source: ["utm_source", "source", "pid", "media_source"],
  medium: ["utm_medium", "medium"],
  campaign: ["utm_campaign", "campaign", "campaign_name"],
  campaignId: ["utm_id", "campaign_id", "utm_campaign_id"],
  content: ["utm_content", "content", "creative"],
  term: ["utm_term", "term", "ad_group", "keyword"],
  referralId: ["referral_code", "invite_code", "referrer_id", "ref", "referral_id"],
} as const;
const STANDARD = new Set<string>([...Object.values(ALIASES).flat(), "referrer", "referer", "click_id", "deep_link", "deep_link_url", "install_referrer"]);

const clickIdLower: Record<string, true> = Object.fromEntries(Object.keys(CLICK_ID_CHANNELS).map((k) => [k.toLowerCase(), true]));

const text = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** Source / medium form used for matching: lower case, inner spaces as "_", wrapping parentheses kept. */
export function normalizeLabel(v: unknown): string | null {
  const s = text(v, MAX).toLowerCase().replace(/\s+/g, "_");
  return s || null;
}

export function hostOf(v: unknown): string | null {
  const s = text(v, 2000);
  if (!s) return null;
  try {
    const h = new URL(s.includes("://") ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Normalises a flat parameter map. Later keys in each alias list only fill a
 * value the earlier ones left empty (utm_source wins over source).
 */
export function normalizeTouch(params: Record<string, unknown>): NormalizedTouch {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (Object.keys(raw).length >= 50) break;
    const s = text(v);
    if (k && k.length <= 60 && s) raw[k] = s;
  }
  const lower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const first = (keys: readonly string[]) => {
    for (const k of keys) {
      const v = lower.get(k);
      if (v) return v.slice(0, MAX);
    }
    return null;
  };
  const clickIds: Record<string, string> = {};
  for (const param of Object.keys(CLICK_ID_CHANNELS)) {
    const v = lower.get(param.toLowerCase());
    const canonical = param === "sccid" ? "ScCid" : param;
    if (v && !clickIds[canonical]) clickIds[canonical] = v;
  }
  const custom: Record<string, string> = {};
  for (const [k, v] of lower) {
    if (Object.keys(custom).length >= 20) break;
    if (STANDARD.has(k) || k in clickIdLower) continue;
    if (/^utm_[a-z0-9_]+$/.test(k) || /^(cd|custom)_[a-z0-9_]{1,40}$/.test(k)) custom[k] = v.slice(0, MAX);
  }
  return {
    source: normalizeLabel(first(ALIASES.source)),
    medium: normalizeLabel(first(ALIASES.medium)),
    campaign: first(ALIASES.campaign),
    campaignId: first(ALIASES.campaignId),
    content: first(ALIASES.content),
    term: first(ALIASES.term),
    clickIds,
    referralId: first(ALIASES.referralId),
    referrerHost: hostOf(lower.get("referrer") ?? lower.get("referer")),
    custom,
    raw,
  };
}


/** True when a touch carries nothing that says where it came from. */
export function isEmptyTouch(t: Pick<NormalizedTouch, "source" | "medium" | "clickIds" | "referrerHost" | "referralId" | "campaign">): boolean {
  return !t.source && !t.medium && !t.campaign && !t.referrerHost && !t.referralId && Object.keys(t.clickIds).length === 0;
}
