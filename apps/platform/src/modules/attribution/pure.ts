/**
 * Pure attribution logic (no database): user-agent classification, bot and
 * prefetch filtering, redirect destinations, install-referrer parsing, click
 * signals carried by events, revenue extraction, postback macros and retry
 * backoff. Unit-tested in pure.test.ts.
 */

/** Events that mark an install (first open after install). */
export const INSTALL_EVENTS: ReadonlySet<string> = new Set(["app_installed"]);
/** Server-side context the ingestion API adds (clients can't set it; it is stripped from input). */
export const SERVER_CONTEXT_KEY = "_server";

export type Os = "ios" | "android" | "other";

export function parseUserAgent(ua: string | null | undefined): { os: Os; major: string | null } {
  const s = ua ?? "";
  let m = /(?:iPhone|iPad|iPod).*?OS (\d+)[_.]/i.exec(s);
  if (m) return { os: "ios", major: m[1] };
  if (/iPhone|iPad|iPod/i.test(s)) return { os: "ios", major: null };
  m = /Android (\d+)/i.exec(s);
  if (m) return { os: "android", major: m[1] };
  if (/Android/i.test(s)) return { os: "android", major: null };
  return { os: "other", major: null };
}

const BOT_UA =
  /bot\b|bot\/|crawler|spider|slurp|facebookexternalhit|facebot|meta-externalagent|whatsapp|telegrambot|twitterbot|slackbot|slack-imgproxy|discordbot|linkedinbot|embedly|pinterest|skypeuripreview|vkshare|bingpreview|googleother|google-inspectiontool|apis-google|mediapartners|adsbot|feedfetcher|headlesschrome|phantomjs|lighthouse|pagespeed|prerender|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|java\/|libwww|httpclient|okhttp|axios\/|node-fetch|undici|scrapy|ahrefs|semrush|mj12|dotbot|yandex|baiduspider|petalbot|bytespider|applebot|amazonbot|gptbot|chatgpt|claudebot|perplexity|ccbot|iframely|outbrain|quora link preview|redditbot|zoominfo|uptime|monitor|statuscake|pingdom/i;

/** Crawlers, link unfurlers and scripted clients: redirected, never recorded as clicks. */
export function isBot(ua: string | null | undefined): boolean {
  const s = (ua ?? "").trim();
  if (s.length < 10) return true;
  return BOT_UA.test(s);
}

/** Browser / router prefetches and previews: redirected, never recorded. */
export function isPrefetch(headers: Headers): boolean {
  const purpose = `${headers.get("purpose") ?? ""} ${headers.get("sec-purpose") ?? ""} ${headers.get("x-purpose") ?? ""} ${headers.get("x-moz") ?? ""}`.toLowerCase();
  return /prefetch|preview|prerender/.test(purpose) || headers.has("next-router-prefetch");
}

/** Ad-network click id parameters and the network each belongs to. */
export const NETWORK_CLICK_IDS: Record<string, string> = {
  gclid: "google",
  gbraid: "google",
  wbraid: "google",
  fbclid: "meta",
  ttclid: "tiktok",
  ScCid: "snapchat",
  sccid: "snapchat",
  twclid: "x",
  msclkid: "microsoft",
  li_fat_id: "linkedin",
};

/** The ad network a source name refers to, for postback routing. */
export function networkOfSource(source: string | null | undefined): string | null {
  const s = (source ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("snap")) return "snapchat";
  if (["facebook", "fb", "instagram", "ig", "meta", "messenger", "audiencenetwork"].some((k) => s.startsWith(k))) return "meta";
  if (s.startsWith("google") || s === "youtube" || s === "adwords") return "google";
  return null;
}

export interface LinkDestinations {
  code: string;
  source: string;
  medium: string | null;
  campaign: string | null;
  ad_group: string | null;
  creative: string | null;
  ios_url: string | null;
  android_url: string | null;
  web_url: string | null;
  deep_link_path: string | null;
}

function withParams(url: string, params: Record<string, string | null | undefined>): string {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

/** The Play Store `referrer` value: what the Play Install Referrer API hands the app after install. */
export function playReferrer(link: LinkDestinations, clickId: string | null): string {
  const q = new URLSearchParams();
  if (clickId) q.set("click_id", clickId);
  q.set("utm_source", link.source);
  if (link.medium) q.set("utm_medium", link.medium);
  if (link.campaign) q.set("utm_campaign", link.campaign);
  if (link.ad_group) q.set("utm_term", link.ad_group);
  if (link.creative) q.set("utm_content", link.creative);
  if (link.deep_link_path) q.set("deep_link", link.deep_link_path);
  return q.toString();
}

/**
 * Where a click goes: iOS → App Store, Android → Play Store with a `referrer`
 * carrying the click id, everything else → the web fallback. Missing
 * destinations fall back in that order.
 */
export function destinationFor(link: LinkDestinations, os: Os, clickId: string | null): string {
  const order = os === "ios" ? [link.ios_url, link.web_url, link.android_url] : os === "android" ? [link.android_url, link.web_url, link.ios_url] : [link.web_url, link.ios_url, link.android_url];
  const url = order.find((u): u is string => Boolean(u))!;
  if (url === link.android_url && /^https:\/\/play\.google\.com\//i.test(url)) return withParams(url, { referrer: playReferrer(link, clickId) });
  if (url === link.web_url) {
    return withParams(url, {
      click_id: clickId,
      utm_source: link.source,
      utm_medium: link.medium,
      utm_campaign: link.campaign,
    });
  }
  return url;
}

/** Parses an install referrer / query string (tolerates one extra level of URL encoding). */
export function parseQuery(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  let s = raw.trim();
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(q + 1);
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  if (!s.includes("=") && /%3D/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(s)) if (k && v && !(k in out)) out[k] = v.slice(0, 1000);
  return out;
}

export interface ClickSignals {
  /** LeanApp click id and where it came from. */
  clickId: { value: string; key: "click_id" | "install_referrer" | "deep_link" } | null;
  /** First ad-network click id found. */
  networkClickId: { param: string; value: string; network: string } | null;
  utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  deepLinkUrl: string | null;
  installReferrer: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 1000) : undefined);

/**
 * What an event's context says about how the user arrived. Reads
 * `context.attribution` (JS SDK: utm_*, click ids, click_id, deep_link_url,
 * install_referrer) and `context.campaign` (native SDKs: install_referrer and
 * the same keys). Never throws on odd shapes.
 */
export function clickSignals(context: Record<string, unknown>): ClickSignals {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const a = obj(context.attribution);
  const c = obj(context.campaign);
  const get = (k: string) => str(a[k]) ?? str(c[k]);
  const installReferrer = get("install_referrer") ?? null;
  const deepLinkUrl = get("deep_link_url") ?? get("deep_link") ?? null;
  const ref = parseQuery(installReferrer);
  const dl = parseQuery(deepLinkUrl);
  const isOurs = (v: string | undefined) => (v && /^lac_[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined);

  let clickId: ClickSignals["clickId"] = null;
  const fromRef = isOurs(ref.click_id);
  const fromDl = isOurs(dl.click_id);
  const direct = isOurs(get("click_id"));
  if (fromRef) clickId = { value: fromRef, key: "install_referrer" };
  else if (fromDl) clickId = { value: fromDl, key: "deep_link" };
  else if (direct) clickId = { value: direct, key: "click_id" };

  let networkClickId: ClickSignals["networkClickId"] = null;
  for (const [param, network] of Object.entries(NETWORK_CLICK_IDS)) {
    const v = get(param) ?? str(ref[param]) ?? str(dl[param]);
    if (v) {
      networkClickId = { param: param === "sccid" ? "ScCid" : param, value: v, network };
      break;
    }
  }
  const pick = (k: string) => get(k) ?? str(ref[k]) ?? str(dl[k]);
  const utm = {
    source: pick("utm_source"),
    medium: pick("utm_medium"),
    campaign: pick("utm_campaign"),
    term: pick("utm_term"),
    content: pick("utm_content"),
  };
  return { clickId, networkClickId, utm, deepLinkUrl, installReferrer };
}

/**
 * Campaign parameters that say the install was not driven by a campaign: the
 * Play Store's own organic referrer ("utm_source=google-play&utm_medium=organic")
 * and the "direct / none" values web tools write. Such installs are organic.
 */
export function isOrganicUtm(utm: { source?: string; medium?: string }): boolean {
  const norm = (v: string | undefined) => v?.trim().toLowerCase().replace(/^\((.*)\)$/, "$1");
  const source = norm(utm.source);
  const medium = norm(utm.medium);
  return medium === "organic" || medium === "none" || source === "organic" || source === "direct" || source === "not set";
}

/** Revenue and currency of a conversion event, from the catalog's property names. Refunds count negative. */
export function extractRevenue(eventName: string, props: Record<string, unknown>): { revenue: number | null; currency: string | null } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  let revenue: number | null = null;
  if (/refund/.test(eventName)) {
    const r = num(props.refund_amount) ?? num(props.revenue) ?? num(props.amount);
    revenue = r === null ? null : -Math.abs(r);
  } else {
    revenue = num(props.revenue) ?? num(props.value) ?? num(props.amount) ?? num(props.price);
  }
  const cur = typeof props.currency === "string" && /^[A-Za-z]{3}$/.test(props.currency.trim()) ? props.currency.trim().toUpperCase() : null;
  return { revenue, currency: revenue === null ? null : cur };
}

/** Macros a custom postback URL may use. */
export const POSTBACK_MACROS = [
  "click_id", "network_click_id", "network_click_param", "event", "event_id", "revenue", "currency", "timestamp", "event_time",
  "install_timestamp", "platform", "source", "medium", "campaign", "link_code", "match_type", "country",
] as const;
export type PostbackPayload = Partial<Record<(typeof POSTBACK_MACROS)[number], string | number | null>>;

/** Replaces {macro} with URL-encoded values; unknown or empty macros become empty strings. */
export function expandMacros(template: string, payload: PostbackPayload): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = (payload as Record<string, unknown>)[name];
    return v === null || v === undefined ? "" : encodeURIComponent(String(v));
  });
}

/** Unknown macros in a template, for validation when it is saved. */
export function unknownMacros(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((m) => !(POSTBACK_MACROS as readonly string[]).includes(m));
}

/** Retry schedule after the n-th failed attempt (1-based); null = give up. */
const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 43_200];
export const MAX_POSTBACK_ATTEMPTS = BACKOFF_SECONDS.length + 1;
export function backoffSeconds(attempt: number): number | null {
  return attempt >= 1 && attempt <= BACKOFF_SECONDS.length ? BACKOFF_SECONDS[attempt - 1] : null;
}

/** HTTP outcomes worth retrying: network errors (null), 408, 425, 429, 5xx. */
export function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * One row per source and campaign from per-currency conversion rows: the
 * conversions add up (a conversion with no amount has no currency), the
 * revenue stays per currency because amounts are never converted.
 */
export function mergeCampaignRows<R extends { source: string; campaign: string | null; currency: string | null; conversions: number; revenue: number }>(
  rows: R[],
): { source: string; campaign: string | null; conversions: number; revenue: { currency: string; amount: number }[] }[] {
  const out = new Map<string, { source: string; campaign: string | null; conversions: number; revenue: { currency: string; amount: number }[] }>();
  for (const r of rows) {
    const key = `${r.source}\u0000${r.campaign ?? ""}`;
    const row = out.get(key) ?? { source: r.source, campaign: r.campaign, conversions: 0, revenue: [] };
    row.conversions += r.conversions;
    if (r.currency && r.revenue) row.revenue.push({ currency: r.currency, amount: r.revenue });
    out.set(key, row);
  }
  const total = (r: { revenue: { amount: number }[] }) => r.revenue.reduce((n, x) => n + x.amount, 0);
  return [...out.values()].sort((a, b) => total(b) - total(a) || b.conversions - a.conversions);
}
