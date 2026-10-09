/**
 * `context.attribution` on the event wire format: a string map with well-known keys.
 *
 * The map stays open (unknown string keys are still accepted, as before) so older SDKs and
 * custom keys keep working; the well-known keys below are typed and documented in
 * docs/events.md. The SDKs only send what they observed (URL parameters, the page's
 * referrer, cookies Meta's own Pixel set, Apple's AdServices token). Nothing here is
 * inferred: an event without these keys simply carries no attribution evidence.
 */
import { z } from "zod";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"] as const;

/** Ad-network click ids. Snapchat's is sent as ScCid by the SDKs; sccid is accepted too. */
export const CLICK_ID_KEYS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "sccid", "twclid", "li_fat_id", "msclkid", "click_id"] as const;

/** Campaign / ad set / ad ids an ad network put on the landing URL (its URL macros). */
export const CAMPAIGN_ID_KEYS = ["campaign_id", "adset_id", "ad_id"] as const;

/** `touch` says which stored touch the SDK sent: the device's first, or its latest. */
export const TOUCH_VALUES = ["first", "latest"] as const;
export type TouchKind = (typeof TOUCH_VALUES)[number];

export const MAX_ATTRIBUTION_KEYS = 64;
export const MAX_ATTRIBUTION_KEY_LENGTH = 60;
export const MAX_ATTRIBUTION_VALUE_LENGTH = 1000;
/** Apple's AdServices attribution token is longer than a URL parameter. */
export const MAX_ADSERVICES_TOKEN_LENGTH = 4096;

export interface AttributionContext {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ttclid?: string;
  ScCid?: string;
  sccid?: string;
  twclid?: string;
  li_fat_id?: string;
  msclkid?: string;
  click_id?: string;
  /** Web: the page the visit landed on (origin + path + attribution parameters only). */
  landing_url?: string;
  /** Web: the external page that sent the visitor (origin + path). Internal navigation is never sent. */
  referrer?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  /** Web: Meta's _fbp / _fbc cookies when Meta's Pixel set them (fbc may be built from an observed fbclid). */
  fbp?: string;
  fbc?: string;
  /** iOS, app_installed only: AAAttribution.attributionToken() (iOS 14.3+). */
  adservices_token?: string;
  /** Native SDKs: the deep link URL the touch came from. */
  deep_link_url?: string;
  touch?: TouchKind;
  [key: string]: string | undefined;
}

const value = z.string().max(MAX_ATTRIBUTION_VALUE_LENGTH);

/** Backward compatible with the old `z.record(string(60), string(1000))`, plus the longer AdServices token. */
export const attributionContextSchema = z
  .object({ adservices_token: z.string().max(MAX_ADSERVICES_TOKEN_LENGTH).optional() })
  .catchall(value)
  .superRefine((m, ctx) => {
    const keys = Object.keys(m);
    if (keys.length > MAX_ATTRIBUTION_KEYS) ctx.addIssue({ code: "custom", message: `at most ${MAX_ATTRIBUTION_KEYS} attribution keys` });
    for (const k of keys) {
      if (!k.length || k.length > MAX_ATTRIBUTION_KEY_LENGTH) ctx.addIssue({ code: "custom", path: [k], message: `attribution keys are 1-${MAX_ATTRIBUTION_KEY_LENGTH} characters` });
    }
  });

/**
 * Removes well-known values that cannot be right (a `touch` other than first/latest) and
 * returns a warning for each, so the rest of the event is still stored.
 */
export function sanitizeAttribution(attr: Record<string, string>): { attribution: AttributionContext; warnings: { field: string; message: string }[] } {
  const out: AttributionContext = { ...attr };
  const warnings: { field: string; message: string }[] = [];
  if (out.touch !== undefined && !(TOUCH_VALUES as readonly string[]).includes(out.touch)) {
    warnings.push({ field: "context.attribution.touch", message: "touch must be first or latest; ignored" });
    delete out.touch;
  }
  for (const k of ["landing_url", "referrer"] as const) {
    const v = out[k];
    if (v !== undefined && !/^https?:\/\//i.test(v)) {
      warnings.push({ field: `context.attribution.${k}`, message: `${k} must be an http(s) URL; ignored` });
      delete out[k];
    }
  }
  return { attribution: out, warnings };
}

function host(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * True when the referrer is another site than the landing page. Without a landing URL a
 * referrer counts as external (the web SDK never sends internal referrers).
 */
export function isExternalReferrer(referrer: string | undefined, landingUrl: string | undefined): boolean {
  const r = host(referrer);
  if (!r) return false;
  const l = host(landingUrl);
  return !l || l !== r;
}

export interface AttributionEvidence {
  utm: Partial<Record<(typeof UTM_KEYS)[number], string>>;
  /** Click ids present, by parameter (sccid reported as ScCid). */
  clickIds: Record<string, string>;
  campaignIds: Partial<Record<(typeof CAMPAIGN_ID_KEYS)[number], string>>;
  externalReferrer: string | null;
  landingUrl: string | null;
  touch: TouchKind | null;
  /** True when there is at least one UTM, click id or external referrer: the evidence of a touch. */
  hasTouch: boolean;
}

/** What an attribution map actually shows. Pure; used by the attribution engine and tests. */
export function attributionEvidence(attr: Record<string, string | undefined> | null | undefined): AttributionEvidence {
  const a = attr ?? {};
  const utm: AttributionEvidence["utm"] = {};
  for (const k of UTM_KEYS) if (a[k]) utm[k] = a[k];
  const clickIds: Record<string, string> = {};
  for (const k of CLICK_ID_KEYS) if (a[k]) clickIds[k === "sccid" ? "ScCid" : k] = a[k]!;
  const campaignIds: AttributionEvidence["campaignIds"] = {};
  for (const k of CAMPAIGN_ID_KEYS) if (a[k]) campaignIds[k] = a[k];
  const externalReferrer = a.referrer && isExternalReferrer(a.referrer, a.landing_url) ? a.referrer : null;
  const touch = a.touch === "first" || a.touch === "latest" ? a.touch : null;
  return {
    utm,
    clickIds,
    campaignIds,
    externalReferrer,
    landingUrl: a.landing_url ?? null,
    touch,
    hasTouch: Object.keys(utm).length > 0 || Object.keys(clickIds).length > 0 || externalReferrer !== null,
  };
}
