/**
 * Pure attribution decisions (no database), used by the engine in ./engine.ts
 * and unit-tested in pure-credit.test.ts:
 *
 *   windows       app-wide click lookback and conversion window, with optional
 *                 overrides per channel (ad networks keep their own windows in
 *                 their own reports; LeanApp never assumes they match)
 *   web touches   what a web event's context says about how the visitor arrived
 *                 (UTM parameters, click ids, landing page, external referrer)
 *   decisions     method, confidence and limitations of every match
 *   credits       last touch, first touch and last non-direct touch of a
 *                 conversion among the person's stored touches
 *
 * Direct, organic-without-campaign and unattributed touches are "weak": they
 * are kept (history is never overwritten) but never take last-non-direct
 * credit from a known earlier source.
 */
import { classifyAttribution } from "@/modules/channels/classify";
import { hostOf } from "@/modules/channels/normalize";
import { BUILT_IN_CHANNELS } from "@/modules/channels/registry";
import { clickSignals, organicReason, parseQuery, type ClickSignals, type MatchType } from "./pure";

// ── Windows ─────────────────────────────────────────────────────────────────

export interface WindowOverride {
  click_lookback_days?: number;
  conversion_window_days?: number;
}
/** Channel key → windows that replace the app-wide ones for touches of that channel. */
export type WindowOverrides = Record<string, WindowOverride>;

export interface WindowSettings {
  click_lookback_days: number;
  conversion_window_days: number;
  window_overrides?: WindowOverrides | null;
}

export const CLICK_LOOKBACK_RANGE = { min: 1, max: 90 } as const;
export const CONVERSION_WINDOW_RANGE = { min: 1, max: 730 } as const;

/** Channels a window can be set for: every built-in channel that has a source behind it. */
export const WINDOW_CHANNELS: readonly string[] = BUILT_IN_CHANNELS.filter((c) => c.group !== "none").map((c) => c.key);
/** The ones the settings page lists (paid networks keep the most different windows). */
export const WINDOW_FORM_CHANNELS: readonly string[] = BUILT_IN_CHANNELS.filter((c) => c.group === "paid").map((c) => c.key);

const intIn = (v: unknown, r: { min: number; max: number }): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= r.min && n <= r.max ? n : undefined;
};

/**
 * Overrides as stored or submitted, keeping only known channels and in-range
 * whole numbers. Anything else is dropped, never guessed.
 */
export function parseWindowOverrides(v: unknown): WindowOverrides {
  const out: WindowOverrides = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!WINDOW_CHANNELS.includes(key) || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const o: WindowOverride = {};
    const click = intIn(r.click_lookback_days, CLICK_LOOKBACK_RANGE);
    const conv = intIn(r.conversion_window_days, CONVERSION_WINDOW_RANGE);
    if (click !== undefined) o.click_lookback_days = click;
    if (conv !== undefined) o.conversion_window_days = conv;
    if (Object.keys(o).length) out[key] = o;
  }
  return out;
}

export function clickLookbackDays(s: WindowSettings, channel: string | null): number {
  return (channel && s.window_overrides?.[channel]?.click_lookback_days) || s.click_lookback_days;
}
export function conversionWindowDays(s: WindowSettings, channel: string | null): number {
  return (channel && s.window_overrides?.[channel]?.conversion_window_days) || s.conversion_window_days;
}
/** The longest click lookback any channel uses: the database search bound. */
export function maxClickLookbackDays(s: WindowSettings): number {
  return Math.max(s.click_lookback_days, ...Object.values(s.window_overrides ?? {}).map((o) => o.click_lookback_days ?? 0));
}
export function maxConversionWindowDays(s: WindowSettings): number {
  return Math.max(s.conversion_window_days, ...Object.values(s.window_overrides ?? {}).map((o) => o.conversion_window_days ?? 0));
}

// ── Touch facts and channels ────────────────────────────────────────────────

/** What a stored attribution event says about its source (the denormalised columns). */
export interface TouchFacts {
  source: string | null;
  medium: string | null;
  network: string | null;
  match_type: string;
  match_key: string | null;
  referrer_host?: string | null;
  /** Only matters when there is no source: a campaign name alone is an unknown source, not "nothing". */
  campaign?: string | null;
}

/** The channel of a touch under the built-in rules (custom rules apply at report time). */
export function engineChannel(t: TouchFacts): string {
  return classifyAttribution({ ...t, referrer_host: t.referrer_host ?? null, campaign: t.campaign ?? null }).channel;
}

/**
 * A weak touch has no known source behind it: nothing matched (organic match
 * type, which covers store-organic, direct and unattributed installs) or it
 * classifies as direct / unattributed. Weak touches never take last-non-direct
 * credit from a known earlier source.
 */
export function isWeakTouch(t: TouchFacts): boolean {
  if (t.match_type === "organic") return true;
  const ch = engineChannel(t);
  return ch === "direct" || ch === "unattributed";
}

// ── Decisions ───────────────────────────────────────────────────────────────

export const CONFIDENCE = ["high", "medium", "low", "none"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** How a touch was established. Stored in attribution_events.method. */
export const METHODS = [
  "leanapp_click", "deferred_deep_link", "network_click_recorded", "network_click_reported", "play_install_referrer", "utm_parameters",
  "referrer", "probabilistic_ip_os", "store_organic", "direct", "organic_parameters", "none",
] as const;
export type Method = (typeof METHODS)[number];

/**
 * Limitation codes stored with the evidence (stable keys; the UI words them):
 *   self_reported            the parameters come from the visit / install itself; nothing of LeanApp's verifies them
 *   click_id_not_proof_of_ad fbclid (and similar) is added to organic link shares too
 *   referrer_only            only the referring page is known; browsers strip or shorten referrers
 *   modeled                  inferred from network address and OS version, not observed
 *   ios_no_click_id          iOS install without a click id: paid installs can't be told from organic here
 *   no_evidence              nothing observed or matched
 */
export type Limitation = "self_reported" | "click_id_not_proof_of_ad" | "referrer_only" | "modeled" | "ios_no_click_id" | "no_evidence";

const NETWORK_CLICK_KEYS = new Set(["gclid", "gbraid", "wbraid", "dclid", "fbclid", "ttclid", "ScCid", "sccid", "twclid", "msclkid", "li_fat_id", "epik"]);
/** Click ids that platforms also append to organic (unpaid) link shares. */
const NOT_PROOF_OF_AD = new Set(["fbclid", "twclid"]);

export interface Decision {
  method: Method;
  confidence: Confidence;
  limitations: Limitation[];
}

/** Method, confidence and limitations of a stored match (match_type + match_key, see ./pure.ts). */
export function describeMatch(matchType: MatchType | string, matchKey: string | null, opts: { ios?: boolean; deferred?: boolean } = {}): Decision {
  const lim: Limitation[] = [];
  switch (matchType) {
    case "deterministic": {
      if (matchKey && NETWORK_CLICK_KEYS.has(matchKey)) return { method: "network_click_recorded", confidence: "high", limitations: NOT_PROOF_OF_AD.has(matchKey) ? ["click_id_not_proof_of_ad"] : [] };
      return { method: opts.deferred ? "deferred_deep_link" : "leanapp_click", confidence: "high", limitations: [] };
    }
    case "reported": {
      if (matchKey && NETWORK_CLICK_KEYS.has(matchKey)) {
        lim.push("self_reported");
        if (NOT_PROOF_OF_AD.has(matchKey)) lim.push("click_id_not_proof_of_ad");
        return { method: "network_click_reported", confidence: NOT_PROOF_OF_AD.has(matchKey) ? "low" : "medium", limitations: lim };
      }
      if (matchKey === "install_referrer") return { method: "play_install_referrer", confidence: "medium", limitations: [] };
      if (matchKey === "referrer") return { method: "referrer", confidence: "low", limitations: ["referrer_only"] };
      return { method: "utm_parameters", confidence: "medium", limitations: ["self_reported"] };
    }
    case "probabilistic":
      return { method: "probabilistic_ip_os", confidence: "low", limitations: ["modeled"] };
    default: {
      if (matchKey === "store_organic") return { method: "store_organic", confidence: "medium", limitations: [] };
      if (matchKey === "direct") return { method: "direct", confidence: "medium", limitations: ["self_reported"] };
      if (matchKey === "organic_other") return { method: "organic_parameters", confidence: "low", limitations: ["self_reported"] };
      return { method: "none", confidence: "none", limitations: opts.ios ? ["no_evidence", "ios_no_click_id"] : ["no_evidence"] };
    }
  }
}

// ── Web touches ─────────────────────────────────────────────────────────────

export interface WebTouch {
  signals: ClickSignals;
  utmPresent: boolean;
  /** Landing page without query string or fragment (those can carry personal data). */
  landingPage: string | null;
  landingHost: string | null;
  referrerHost: string | null;
  /** The referrer is another site than the landing page. */
  externalReferrer: boolean;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  /** The SDK's label for the touch it sent (first or latest), when it said. */
  touch: "first" | "latest" | null;
  /** Stable hash of the campaign evidence, for de-duplication. */
  signature: string;
  /** Names of the attribution keys that were present (values are not kept here). */
  keys: string[];
}

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : null);

function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function stripUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

/** FNV-1a, 32 bit, hex: stable and dependency-free (not a security hash). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The touch a web event carries, or null when it carries no campaign evidence
 * (no UTM parameter, no click id, no external referrer), when it isn't a web
 * event, or when the event itself says attribution consent was denied.
 * Reads `context.attribution` (the shared contract: utm_*, click ids,
 * landing_url, referrer, campaign_id, adset_id, ad_id, touch); UTM
 * parameters left in landing_url count too. Never invents a source.
 */
export function webTouchOf(context: Record<string, unknown>, platform: string | null): WebTouch | null {
  const plat = platform ?? str(context.platform);
  if (plat !== "web") return null;
  if (obj(context.consent).attribution === false) return null;
  const a = obj(context.attribution);
  const landingUrl = str(a.landing_url);
  // Explicit context keys win over what the landing URL's query says.
  const merged: Record<string, string> = { ...parseQuery(landingUrl && landingUrl.includes("?") ? landingUrl : null) };
  for (const [k, v] of Object.entries(a)) {
    const s = str(v);
    if (s) merged[k] = s;
  }
  delete merged.deep_link_url;
  delete merged.deep_link;
  delete merged.install_referrer;
  const signals = clickSignals({ attribution: merged });
  const u = signals.utm;
  const utmPresent = Boolean(u.source || u.medium || u.campaign || u.term || u.content || merged.utm_id);
  const landingHost = hostOf(landingUrl);
  const referrerHost = hostOf(merged.referrer ?? merged.referer);
  const externalReferrer = Boolean(referrerHost && (!landingHost || !sameSite(referrerHost, landingHost)));
  if (!utmPresent && !signals.clickId && !signals.networkClickId && !externalReferrer) return null;
  const touch = merged.touch === "first" || merged.touch === "latest" ? merged.touch : null;
  const evidence = [
    u.source, u.medium, u.campaign, u.term, u.content, merged.utm_id, signals.clickId?.value, signals.networkClickId?.value,
    utmPresent || signals.clickId || signals.networkClickId ? null : referrerHost,
  ].map((x) => (x ?? "").toLowerCase());
  return {
    signals,
    utmPresent,
    landingPage: stripUrl(landingUrl),
    landingHost,
    referrerHost: externalReferrer ? referrerHost : null,
    externalReferrer,
    campaignId: str(merged.campaign_id) ?? str(merged.utm_id),
    adsetId: str(merged.adset_id),
    adId: str(merged.ad_id),
    touch,
    signature: fnv1a(evidence.join("\u0001")),
    keys: Object.keys(merged).filter((k) => k !== "touch").sort().slice(0, 40),
  };
}

/**
 * How a web touch is matched before any lookup: a LeanApp or ad-network click
 * id may still turn deterministic when a recorded click backs it (the engine
 * checks); UTM parameters that say direct are a direct touch; otherwise UTM
 * parameters, then a click id, then the referrer are reported.
 */
export function webMatch(w: WebTouch): { matchType: MatchType; matchKey: string } {
  if (w.signals.networkClickId) return { matchType: "reported", matchKey: w.signals.networkClickId.param };
  if (w.utmPresent) {
    const reason = organicReason(w.signals.utm);
    if (reason === "direct") return { matchType: "organic", matchKey: "direct" };
    return { matchType: "reported", matchKey: "utm_parameters" };
  }
  if (w.signals.clickId) return { matchType: "reported", matchKey: "click_id" };
  return { matchType: "reported", matchKey: "referrer" };
}

// ── Credits ─────────────────────────────────────────────────────────────────

export interface CreditCandidate extends TouchFacts {
  id: string;
  kind: string;
  occurred_at: Date;
}

export interface Credits<C extends CreditCandidate = CreditCandidate> {
  /** The latest touch within its channel's conversion window. */
  lastTouch: C | null;
  /** The earliest touch within its channel's conversion window. */
  firstTouch: C | null;
  /** The latest touch with a known source; else the last touch (then `lastNonDirectFallback`). */
  lastNonDirect: C | null;
  /** No touch with a known source was in the window: last non-direct fell back to the last touch. */
  lastNonDirectFallback: boolean;
  /** Touches inside their window / found but outside it. */
  considered: number;
  outsideWindow: number;
}

/**
 * Picks the credited touches of one conversion among the person's touches.
 * A touch counts when it happened at or before the conversion (plus clock
 * skew) and no longer ago than its channel's conversion window. Ties on time
 * are broken by id so the result never depends on row order.
 */
export function pickCredits<C extends CreditCandidate>(candidates: readonly C[], conversionAt: Date, s: WindowSettings, skewMs = 0): Credits<C> {
  const at = conversionAt.getTime();
  const inWindow: C[] = [];
  let outside = 0;
  for (const c of candidates) {
    const t = new Date(c.occurred_at).getTime();
    if (t > at + skewMs) continue; // after the conversion: not a cause of it
    const days = conversionWindowDays(s, engineChannel(c));
    if (t < at - days * 86_400_000) {
      outside++;
      continue;
    }
    inWindow.push(c);
  }
  inWindow.sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime() || a.id.localeCompare(b.id));
  const lastTouch = inWindow.at(-1) ?? null;
  const firstTouch = inWindow[0] ?? null;
  const known = [...inWindow].reverse().find((c) => !isWeakTouch(c)) ?? null;
  return {
    lastTouch,
    firstTouch,
    lastNonDirect: known ?? lastTouch,
    lastNonDirectFallback: !known,
    considered: inWindow.length,
    outsideWindow: outside,
  };
}

/** The evidence stored with a conversion's credit (no personal data: ids of stored touches and counts). */
export function creditEvidence(c: Credits, s: WindowSettings): Record<string, unknown> {
  const describe = (x: CreditCandidate | null) =>
    x ? { id: x.id, kind: x.kind, channel: engineChannel(x), match_type: x.match_type, window_days: conversionWindowDays(s, engineChannel(x)) } : null;
  return {
    last_touch: describe(c.lastTouch),
    first_touch: describe(c.firstTouch),
    last_non_direct: describe(c.lastNonDirect),
    last_non_direct_fallback: c.lastNonDirectFallback,
    touches_considered: c.considered,
    touches_outside_window: c.outsideWindow,
    status: c.lastTouch ? "credited" : c.outsideWindow ? "outside_window" : "no_touch",
  };
}
