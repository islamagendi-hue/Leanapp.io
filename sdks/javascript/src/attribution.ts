/** Campaign parameters and ad-network click ids the SDK captures from deep links and landing URLs. */
export const ATTRIBUTION_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "ttclid",
  "ScCid",
  "twclid",
  "li_fat_id",
  "msclkid",
  "click_id",
] as const;

export type Attribution = Record<string, string>;

/** Extracts attribution parameters from a URL or query string; returns null when there are none. */
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
  return Object.keys(out).length ? out : null;
}
