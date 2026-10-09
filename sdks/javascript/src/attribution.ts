/** UTM parameters. */
export const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id"] as const;

/** Ad-network click ids (Snapchat's is ScCid; sccid is read too). */
export const CLICK_ID_PARAMS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "ScCid", "twclid", "li_fat_id", "msclkid", "click_id"] as const;

/** Campaign / ad set / ad ids from ad-network URL macros. Kept only next to a UTM or click id. */
export const CAMPAIGN_ID_PARAMS = ["campaign_id", "adset_id", "ad_id"] as const;

/** Campaign parameters and ad-network click ids the SDK captures from deep links and landing URLs. */
export const ATTRIBUTION_PARAMS = [...UTM_PARAMS, ...CLICK_ID_PARAMS, ...CAMPAIGN_ID_PARAMS] as const;

export type Attribution = Record<string, string>;

const SOURCE_PARAMS: readonly string[] = [...UTM_PARAMS, ...CLICK_ID_PARAMS];

/** True when the map has a UTM or a click id: evidence of where the user came from. */
export function hasSourceParams(a: Attribution | null | undefined): boolean {
  return !!a && SOURCE_PARAMS.some((p) => !!a[p]);
}

/**
 * Extracts attribution parameters from a URL or query string; returns null when there are none.
 * Campaign / ad set / ad ids alone (often a page's own parameters) are not attribution and give null.
 */
export function parseAttribution(url: string): Attribution | null {
  let search = url;
  const q = url.indexOf("?");
  if (q >= 0) search = url.slice(q + 1);
  const hash = search.indexOf("#");
  if (hash >= 0) search = search.slice(0, hash);
  const out: Attribution = {};
  for (const pair of search.split("&")) {
    if (!pair) continue;
    const [rawK, rawV = ""] = pair.split("=");
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(rawK.replace(/\+/g, " "));
      v = decodeURIComponent(rawV.replace(/\+/g, " "));
    } catch {
      continue;
    }
    const match = ATTRIBUTION_PARAMS.find((p) => p.toLowerCase() === k.toLowerCase());
    if (match && v) out[match] = v.slice(0, 1000);
  }
  return hasSourceParams(out) ? out : null;
}

function parseUrl(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function bareHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * The landing page without anything that could identify a person: origin and path plus the
 * attribution parameters only (other query parameters and the fragment are dropped).
 */
export function landingUrl(url: string, attribution: Attribution | null): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(attribution ?? {})) q.set(k, v);
  const query = q.toString();
  return `${u.origin}${u.pathname}${query ? `?${query}` : ""}`.slice(0, 1000);
}

/**
 * The referrer as origin + path when it is another site than the page (internal navigation,
 * including the hosts in `internalHosts` and their subdomains, gives null).
 */
export function externalReferrer(referrer: string | null | undefined, pageUrl: string, internalHosts: string[] = []): string | null {
  const r = parseUrl(referrer);
  const page = parseUrl(pageUrl);
  if (!r) return null;
  const host = bareHost(r);
  const internal = [...(page ? [bareHost(page)] : []), ...internalHosts.map((h) => h.toLowerCase().replace(/^www\./, ""))];
  if (internal.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return `${r.origin}${r.pathname}`.slice(0, 1000);
}

/**
 * A web visit's touch: the UTMs and click ids on the page URL, the landing page and an external
 * referrer. Null when the visit shows no source (direct, or navigation inside the site): the SDK
 * never makes one up.
 */
export function webTouch(url: string, referrer: string | null | undefined, internalHosts: string[] = []): Attribution | null {
  const params = parseAttribution(url);
  const ref = externalReferrer(referrer, url, internalHosts);
  if (!params && !ref) return null;
  const touch: Attribution = { ...(params ?? {}) };
  const landing = landingUrl(url, params);
  if (landing) touch.landing_url = landing;
  if (ref) touch.referrer = ref;
  return touch;
}

/** Reads one cookie in a browser; null elsewhere or when it is not set. */
export function readCookie(name: string): string | null {
  const doc = (globalThis as { document?: { cookie?: string } }).document;
  if (!doc || typeof doc.cookie !== "string") return null;
  for (const part of doc.cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Meta's browser ids for the Conversions API: the _fbp and _fbc cookies Meta's Pixel sets. When
 * there is no _fbc cookie but the page URL carries an fbclid, fbc is built from that fbclid in
 * Meta's documented format (fb.1.<time in ms>.<fbclid>). Nothing is set without an observed value.
 */
export function metaBrowserIds(fbclid: string | null | undefined, nowMs: number): { fbp?: string; fbc?: string } {
  const out: { fbp?: string; fbc?: string } = {};
  const fbp = readCookie("_fbp");
  const fbc = readCookie("_fbc") ?? (fbclid ? `fb.1.${nowMs}.${fbclid}` : null);
  if (fbp) out.fbp = fbp.slice(0, 1000);
  if (fbc) out.fbc = fbc.slice(0, 1000);
  return out;
}
