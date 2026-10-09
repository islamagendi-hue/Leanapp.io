/**
 * Which channel a touch belongs to, and how sure LeanApp is of it. Pure and
 * client-safe; unit-tested in classify.test.ts. Rules apply at report time,
 * so a changed custom rule re-labels history without rewriting stored data.
 *
 * Order (first match wins):
 *   1. the app's custom rules, by priority
 *   2. an ad-network click id (gclid, fbclid, ttclid, ScCid, …) → that network's paid channel
 *   3. explicit direct ("(direct)", utm_source=direct with no medium or medium none)
 *   4. a paid medium (cpc, paid_social, display, app…) → the source's paid channel, else unknown
 *   5. utm_medium=organic → app store, search or social when the source says which, else unknown
 *   6. a medium that names a channel (email, sms, push, influencer, qr, referral…)
 *   7. a source that names a channel (paid networks with a non-paid medium count as their organic
 *      counterpart: facebook / social → organic social)
 *   8. the referring host (search engines, social sites, the stores; any other site → referral site)
 *   9. anything else that carries data → unknown; nothing at all → unattributed
 */
import { isEmptyTouch, type NormalizedTouch } from "./normalize";
export { NETWORK_CHANNELS } from "./registry";
import {
  builtInChannel, BUILT_IN_CHANNELS, channelBySource, compact, NETWORK_CHANNELS, CLICK_ID_CHANNELS, PAID_MEDIUMS, SEARCH_ENGINES, SOCIAL_MEDIUMS, SOCIAL_SITES, type ChannelDef, type CustomChannel,
} from "./registry";

/** Conditions of a custom rule; every condition given must hold (case-insensitive). */
export interface RuleConditions {
  /** Source equals one of these (normalised). */
  source?: string[];
  medium?: string[];
  /** Campaign starts with this. */
  campaignPrefix?: string;
  /** Referrer host equals or ends with ".{host}". */
  referrerHost?: string;
  /** The touch carries this click id parameter. */
  clickIdParam?: string;
  /** The touch carries a referral / invite id. */
  hasReferralId?: boolean;
}

export interface ChannelRule {
  id: string;
  priority: number;
  channel: string;
  conditions: RuleConditions;
}

export type MatchReason =
  | "custom_rule" | "click_id" | "network" | "direct" | "paid_medium" | "organic_medium" | "medium" | "source" | "referrer" | "store_organic" | "unknown" | "no_touch";

export interface Classification {
  channel: string;
  reason: MatchReason;
  ruleId?: string;
}

/** Organic counterpart of a paid network's source when the medium isn't paid. */
const ORGANIC_COUNTERPART: Record<string, string> = {
  meta_ads: "organic_social", tiktok_ads: "organic_social", snapchat_ads: "organic_social", linkedin_ads: "organic_social", pinterest_ads: "organic_social",
  x_ads: "organic_social", google_ads: "organic_search", microsoft_ads: "organic_search", apple_search_ads: "app_store",
};

const lc = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const isNone = (v: string | null) => !v || ["none", "(none)", "(not set)", "not_set", "not set"].includes(v);

function channelByMedium(medium: string | null): ChannelDef | undefined {
  if (!medium) return undefined;
  return BUILT_IN_CHANNELS.find((d) => d.mediums?.includes(medium));
}

function hostIn(host: string, list: readonly string[]): boolean {
  return list.some((h) => (h.endsWith(".") ? host.startsWith(h) || host.includes(`.${h}`) : host === h || host.endsWith(`.${h}`)));
}

export function channelByReferrer(host: string | null): string | null {
  if (!host) return null;
  if (hostIn(host, SEARCH_ENGINES)) return "organic_search";
  if (hostIn(host, SOCIAL_SITES)) return "organic_social";
  if (hostIn(host, builtInChannel("app_store")!.referrers!)) return "app_store";
  return "referral_site";
}

function ruleMatches(r: RuleConditions, t: NormalizedTouch): boolean {
  let any = false;
  if (r.source?.length) {
    any = true;
    if (!t.source || !r.source.map(lc).includes(t.source)) return false;
  }
  if (r.medium?.length) {
    any = true;
    if (!t.medium || !r.medium.map(lc).includes(t.medium)) return false;
  }
  if (r.campaignPrefix) {
    any = true;
    if (!lc(t.campaign).startsWith(lc(r.campaignPrefix))) return false;
  }
  if (r.referrerHost) {
    any = true;
    const h = lc(r.referrerHost).replace(/^www\./, "");
    if (!t.referrerHost || !(t.referrerHost === h || t.referrerHost.endsWith(`.${h}`))) return false;
  }
  if (r.clickIdParam) {
    any = true;
    if (!Object.keys(t.clickIds).some((k) => k.toLowerCase() === lc(r.clickIdParam))) return false;
  }
  if (r.hasReferralId !== undefined) {
    any = true;
    if (Boolean(t.referralId) !== r.hasReferralId) return false;
  }
  return any;
}

export interface ClassifyContext {
  /** The app's custom rules (any order; sorted by priority here). */
  rules?: readonly ChannelRule[];
  /** Custom channels that exist; a rule pointing at a missing one is skipped. */
  customChannels?: readonly CustomChannel[];
  /** Network already resolved for the touch (attribution_events.network). */
  network?: string | null;
  /** The install's organic referrer said so (match_key store_organic / direct, see attribution engine). */
  matchKey?: string | null;
}

export function classifyTouch(t: NormalizedTouch, ctx: ClassifyContext = {}): Classification {
  const customKeys = new Set((ctx.customChannels ?? []).map((c) => c.key));
  const rules = [...(ctx.rules ?? [])].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const r of rules) {
    if (!builtInChannel(r.channel) && !customKeys.has(r.channel)) continue;
    if (ruleMatches(r.conditions, t)) return { channel: r.channel, reason: "custom_rule", ruleId: r.id };
  }
  if (ctx.matchKey === "store_organic") return { channel: "app_store", reason: "store_organic" };
  if (ctx.matchKey === "direct") return { channel: "direct", reason: "direct" };
  if (ctx.matchKey === "organic_other") return { channel: "unknown", reason: "unknown" };

  for (const param of Object.keys(t.clickIds)) {
    const ch = CLICK_ID_CHANNELS[param];
    if (ch) return { channel: ch, reason: "click_id" };
  }
  // A network resolved from a click id the touch no longer carries (stored attributions).
  if (ctx.network && NETWORK_CHANNELS[ctx.network] && (isNone(t.medium) || PAID_MEDIUMS.has(t.medium!))) return { channel: NETWORK_CHANNELS[ctx.network], reason: "network" };
  if (isEmptyTouch(t)) return { channel: "unattributed", reason: "no_touch" };

  const source = t.source;
  const medium = isNone(t.medium) ? null : t.medium;
  if ((source === "(direct)" || source === "direct") && !medium) return { channel: "direct", reason: "direct" };

  if (medium && PAID_MEDIUMS.has(medium)) {
    const def = channelBySource(source);
    if (def && def.group !== "organic") return { channel: def.key, reason: "paid_medium" };
    return { channel: "unknown", reason: "unknown" };
  }
  if (medium === "organic") {
    const def = channelBySource(source);
    if (def?.key === "app_store" || ["googleplay", "playstore", "appstore"].includes(compact(source))) return { channel: "app_store", reason: "organic_medium" };
    if (def && ORGANIC_COUNTERPART[def.key]) return { channel: ORGANIC_COUNTERPART[def.key], reason: "organic_medium" };
    if (def?.group === "organic") return { channel: def.key, reason: "organic_medium" };
    return { channel: "unknown", reason: "unknown" };
  }
  if (medium) {
    const def = channelByMedium(medium);
    if (def) return { channel: def.key, reason: "medium" };
  }
  if (source) {
    const def = channelBySource(source);
    if (def) {
      if (def.group === "paid" && medium && ORGANIC_COUNTERPART[def.key]) return { channel: ORGANIC_COUNTERPART[def.key], reason: "source" };
      return { channel: def.key, reason: "source" };
    }
    if (medium && SOCIAL_MEDIUMS.has(medium)) return { channel: "organic_social", reason: "medium" };
    return { channel: "unknown", reason: "unknown" };
  }
  if (medium && SOCIAL_MEDIUMS.has(medium)) return { channel: "organic_social", reason: "medium" };
  if (t.referralId) return { channel: "referral_program", reason: "source" };
  const byRef = channelByReferrer(t.referrerHost);
  if (byRef) return { channel: byRef, reason: "referrer" };
  return { channel: "unknown", reason: "unknown" };
}

// ── Evidence ────────────────────────────────────────────────────────────────

/**
 * How a channel credit is known, shown next to every number:
 *   deterministic      a click id matched a click LeanApp's own link recorded
 *   observed           LeanApp saw the parameters on the install, open or visit, but nothing verifies them
 *   provider_reported  a provider says so in aggregate (SKAdNetwork / AdAttributionKit, ad platform reports)
 *   modeled            inferred (opt-in Android IP + OS match)
 *   none               nothing observed or matched
 */
export const EVIDENCE = ["deterministic", "observed", "provider_reported", "modeled", "none"] as const;
export type Evidence = (typeof EVIDENCE)[number];

/** Evidence of an attribution_events.match_type. */
export function evidenceOf(matchType: string, matchKey?: string | null): Evidence {
  switch (matchType) {
    case "deterministic": return "deterministic";
    case "reported": return "observed";
    case "probabilistic": return "modeled";
    case "provider_reported": return "provider_reported";
    default: return matchKey === "store_organic" || matchKey === "direct" ? "observed" : "none";
  }
}

/**
 * The channel of a stored attribution (attribution_events row): its denormalised
 * source / medium / network, the referring host of a web touch, the match key,
 * and the app's rules.
 */
export function classifyAttribution(
  row: { source: string | null; medium: string | null; network: string | null; match_type: string; match_key: string | null; campaign?: string | null; referrer_host?: string | null },
  ctx: Omit<ClassifyContext, "network" | "matchKey"> = {},
): Classification {
  const t: NormalizedTouch = {
    source: row.source ? row.source.trim().toLowerCase().replace(/\s+/g, "_") : null,
    medium: row.medium ? row.medium.trim().toLowerCase().replace(/\s+/g, "_") : null,
    campaign: row.campaign ?? null, campaignId: null, content: null, term: null, clickIds: {}, referralId: null,
    referrerHost: row.referrer_host ? row.referrer_host.trim().toLowerCase().replace(/^www\./, "") : null, custom: {}, raw: {},
  };
  if (row.match_type === "organic" && !row.source) {
    // Nothing matched: no source, unless the install's organic referrer said where it came from.
    const c = classifyTouch(t, { ...ctx, matchKey: row.match_key });
    return row.match_key || c.reason === "custom_rule" ? c : { channel: "unattributed", reason: "no_touch" };
  }
  return classifyTouch(t, { ...ctx, network: row.network, matchKey: row.match_key });
}
