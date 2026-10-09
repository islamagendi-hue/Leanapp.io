/**
 * Pure deep-linking logic (no database): link URL parsing, the
 * apple-app-site-association and assetlinks.json documents, deep link payloads,
 * social in-app browser detection and the "Open in app" interstitial page.
 * Unit-tested in pure.test.ts.
 */

import { msg } from "@/i18n/translate";

/** Tracking link codes (attribution_links.code). */
export const CODE_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
/** Per-environment link prefix: /l/{prefix}/{code}. */
export const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
/** Prefixes that would be confusing or collide with paths we may want later. */
export const RESERVED_PREFIXES = new Set(["api", "app", "www", "well-known", "static", "assets", "admin", "leanapp", "l", "v1", "test"]);

export const IOS_TEAM_ID = /^[A-Z0-9]{10}$/;
export const IOS_BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const IOS_APP_STORE_ID = /^[0-9]{5,12}$/;
export const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const URI_SCHEME = /^[a-z][a-z0-9+.-]{1,40}$/;
export const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Query parameters that describe the click (campaign labels, click ids), never passed to the app as deep link params. */
export const RESERVED_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "campaign", "ad_group", "creative",
  "click_id", "gclid", "gbraid", "wbraid", "fbclid", "ttclid", "sccid", "twclid", "msclkid", "li_fat_id",
]);

/**
 * Normalizes a signing certificate SHA-256 fingerprint to the form assetlinks.json uses
 * ("AB:CD:…", 32 bytes, upper case). Accepts colons, spaces or plain hex. Null when invalid.
 */
export function normalizeFingerprint(raw: string): string | null {
  const hex = raw.trim().replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/.{2}/g)!.join(":");
}

/** Lower-cased hostname of a Host header value or URL, without port; null when not a hostname. */
export function hostnameOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.split(",")[0].trim().toLowerCase();
  if (!v) return null;
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).hostname || null;
  } catch {
    return null;
  }
}

/** The public URL of a link: /l/{prefix}/{code} when the environment has a deep link configuration, else /l/{code}. */
export function linkUrl(base: string, code: string, prefix: string | null): string {
  return `${base.replace(/\/+$/, "")}/l/${prefix ? `${prefix}/` : ""}${code}`;
}

/** Base URL (scheme + host) links of an environment are served on. */
export function linkBase(defaultBase: string, customDomain: string | null): string {
  return customDomain ? `https://${customDomain}` : defaultBase.replace(/\/+$/, "");
}

/** Parses a link path: /l/{code} or /l/{prefix}/{code} (one trailing slash allowed). */
export function parseLinkPath(pathname: string): { prefix: string | null; code: string } | null {
  const m = /^\/l\/(?:([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\/)?([A-Za-z0-9_-]{6,32})\/?$/.exec(pathname);
  if (!m) return null;
  return { prefix: m[1] ?? null, code: m[2] };
}

// ── Well-known files ────────────────────────────────────────────────────────

export interface AssociationConfig {
  link_prefix: string;
  ios_team_id: string | null;
  ios_bundle_ids: string[];
  android_package: string | null;
  android_sha256: string[];
  /** For the AASA comment only. */
  label?: string;
}

/**
 * apple-app-site-association for one host (iOS 13+ `components` format). Each app is
 * scoped to its own /l/{prefix}/* path, so apps sharing the host never claim each
 * other's links. iOS reads `details` in order and the first match wins.
 */
export function buildAasa(configs: AssociationConfig[]): { applinks: { details: { appIDs: string[]; components: { "/": string; comment?: string }[] }[] } } {
  const details = configs
    .filter((c) => c.ios_team_id && c.ios_bundle_ids.length)
    .sort((a, b) => a.link_prefix.localeCompare(b.link_prefix))
    .map((c) => ({
      appIDs: c.ios_bundle_ids.map((b) => `${c.ios_team_id}.${b}`),
      components: [{ "/": `/l/${c.link_prefix}/*`, ...(c.label ? { comment: c.label } : {}) }],
    }));
  return { applinks: { details } };
}

/** Digital Asset Links statements for one host: every Android app whose links use it. */
export function buildAssetLinks(configs: AssociationConfig[]): { relation: string[]; target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] } }[] {
  return configs
    .filter((c) => c.android_package && c.android_sha256.length)
    .sort((a, b) => a.link_prefix.localeCompare(b.link_prefix))
    .map((c) => ({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app" as const, package_name: c.android_package!, sha256_cert_fingerprints: [...c.android_sha256] },
    }));
}

// ── Deep link payloads ──────────────────────────────────────────────────────

export interface DeepLinkPayload {
  /** The deep link as configured on the link (a path like /product/1 or an app URL like myapp://product/1), without its query. */
  path: string | null;
  /** Query parameters of the configured deep link plus non-campaign parameters added to the opened URL. */
  params: Record<string, string>;
  /** The full deep link with its parameters, ready to route. */
  url: string | null;
}

function splitQuery(s: string): [string, URLSearchParams] {
  const hash = s.indexOf("#");
  const noHash = hash >= 0 ? s.slice(0, hash) : s;
  const q = noHash.indexOf("?");
  return q >= 0 ? [noHash.slice(0, q), new URLSearchParams(noHash.slice(q + 1))] : [noHash, new URLSearchParams()];
}

/**
 * What the app receives for a link. The link's own deep link parameters win over
 * parameters added to the URL; campaign parameters and click ids are never params.
 */
export function deepLinkPayload(deepLinkPath: string | null, opened: URLSearchParams | null): DeepLinkPayload {
  const params: Record<string, string> = {};
  for (const [k, v] of opened ?? []) {
    if (!RESERVED_PARAMS.has(k.toLowerCase()) && k.length <= 60 && !(k in params)) params[k] = v.slice(0, 500);
    if (Object.keys(params).length >= 20) break;
  }
  if (!deepLinkPath) return { path: null, params, url: null };
  const [path, q] = splitQuery(deepLinkPath);
  for (const [k, v] of q) params[k] = v;
  const query = new URLSearchParams(params).toString();
  return { path, params, url: query ? `${path}?${query}` : path };
}

// ── Social in-app browsers ──────────────────────────────────────────────────

/**
 * In-app browsers of social apps that do not hand Universal Links / App Links to the
 * OS, so a tap on a link stays inside the social app. Returns the app's name.
 */
export function inAppBrowser(ua: string | null | undefined): string | null {
  const s = ua ?? "";
  if (/\bInstagram\b/i.test(s)) return "Instagram";
  if (/FBAN\/Messenger|MessengerForiOS|\bOrca-Android\b/i.test(s)) return "Messenger";
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/.test(s)) return "Facebook";
  if (/musical_ly|BytedanceWebview|\bTikTok\b|\btrill_/i.test(s)) return "TikTok";
  if (/Snapchat/i.test(s)) return "Snapchat";
  if (/LinkedInApp/i.test(s)) return "LinkedIn";
  if (/\bLine\/\d/.test(s)) return "LINE";
  if (/MicroMessenger/i.test(s)) return "WeChat";
  return null;
}

/**
 * Android: an intent:// URL for the same https link. Chrome-based in-app browsers hand it
 * to the OS, which opens the verified app (or the fallback URL when it isn't installed).
 */
export function androidIntentUrl(link: string, androidPackage: string, fallback: string): string {
  const u = new URL(link);
  return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(":", "")};package=${androidPackage};` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/**
 * iOS: a custom-scheme URL for the deep link, with the click id and campaign so the SDK
 * can attribute the open. Universal Links don't open from social in-app browsers; a
 * registered URL scheme does (iOS asks the user first).
 */
export function iosSchemeUrl(scheme: string, deepLink: DeepLinkPayload, attribution: Record<string, string | null>): string {
  const target = deepLink.url ?? "/";
  // myapp://product/1 stays; /product/1 becomes myapp://product/1.
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target.replace(/^[a-z][a-z0-9+.-]*:\/\//i, `${scheme}://`) : `${scheme}://${target.replace(/^\/+/, "")}`;
  const [path, q] = splitQuery(base);
  for (const [k, v] of Object.entries(attribution)) if (v) q.set(k, v);
  const query = q.toString();
  return query ? `${path}?${query}` : path;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface InterstitialInput {
  appName: string;
  browser: string;
  os: "ios" | "android" | "other";
  /** "Open in app" target (intent:// on Android, custom scheme on iOS), or null when the app can't be opened from here. */
  openUrl: string | null;
  /** App Store / Play Store / web fallback. */
  storeUrl: string;
  nonce: string;
  arabic: boolean;
}

/**
 * The small page shown inside social in-app browsers instead of a redirect. No
 * script: two links and a hint to open the page in the real browser. Styles carry
 * the response's CSP nonce.
 */
export function interstitialHtml(i: InterstitialInput): string {
  const t = i.arabic
    ? {
        title: `افتح ${i.appName}`,
        lead: `أنت داخل متصفح ${i.browser}.`,
        open: "افتح في التطبيق",
        store: i.os === "ios" ? "حمّل من App Store" : i.os === "android" ? "حمّل من Google Play" : "تابع",
        hint: i.os === "ios" ? "إن لم يفتح التطبيق، اضغط ⋯ ثم «فتح في Safari»." : "إن لم يفتح التطبيق، اضغط ⋮ ثم «فتح في المتصفح».",
      }
    : {
        title: `Open ${i.appName}`,
        lead: `You're in the ${i.browser} browser.`,
        open: "Open in app",
        store: i.os === "ios" ? "Get it on the App Store" : i.os === "android" ? "Get it on Google Play" : "Continue",
        hint: i.os === "ios" ? "If the app doesn't open, tap ⋯ and choose “Open in Safari”." : "If the app doesn't open, tap ⋮ and choose “Open in browser”.",
      };
  const css = `body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f5f2;color:#1b1b1b;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:22rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .25rem}p{color:#555;margin:.25rem 0 1.5rem}
a{display:block;padding:.85rem 1rem;border-radius:.75rem;text-decoration:none;font-weight:600;margin:.75rem 0}
.primary{background:#1b1b1b;color:#fff}.secondary{border:1px solid #ccc;color:#1b1b1b;background:#fff}small{display:block;color:#777;margin-top:1.25rem}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}p,small{color:#aaa}.primary{background:#eee;color:#111}.secondary{background:#222;color:#eee;border-color:#444}}`;
  return `<!doctype html>
<html lang="${i.arabic ? "ar" : "en"}" dir="${i.arabic ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(t.title)}</title><style nonce="${escapeHtml(i.nonce)}">${css}</style></head>
<body><main>
<h1>${escapeHtml(t.title)}</h1>
<p>${escapeHtml(t.lead)}</p>
${i.openUrl ? `<a class="primary" href="${escapeHtml(i.openUrl)}">${escapeHtml(t.open)}</a>` : ""}
<a class="${i.openUrl ? "secondary" : "primary"}" href="${escapeHtml(i.storeUrl)}">${escapeHtml(t.store)}</a>
<small>${escapeHtml(t.hint)}</small>
</main></body></html>`;
}

/** CSP for the interstitial: nothing but its own nonce'd styles and outbound links. */
export function interstitialCsp(nonce: string): string {
  return [`default-src 'none'`, `style-src 'nonce-${nonce}'`, "img-src data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
}

// ── Channels ────────────────────────────────────────────────────────────────

/**
 * Source / medium presets per channel, paid ads included. A link per channel (or per influencer,
 * per QR placement, per ad) keeps reporting clean; the same link works in every channel.
 */
export const CHANNEL_PRESETS = [
  { id: "email", label: msg("Email"), source: "email", medium: "email", hint: msg("Newsletter or lifecycle email. Campaign = the email or flow name.") },
  { id: "sms", label: msg("SMS"), source: "sms", medium: "sms", hint: msg("Keep the link short; the deep link opens the app directly when installed.") },
  { id: "whatsapp", label: "WhatsApp", source: "whatsapp", medium: "messaging", hint: msg("Broadcasts and click-to-chat. WhatsApp shows a preview: previews are not counted as clicks.") },
  { id: "qr", label: msg("QR code"), source: "qr", medium: "offline", hint: msg("Print, packaging, in-store. Use the creative field for the placement (e.g. riyadh_mall_poster).") },
  { id: "influencer", label: msg("Influencer"), source: "influencer", medium: "influencer", hint: msg("One link per creator: put the handle in Creative.") },
  { id: "web_banner", label: msg("Web banner"), source: "website", medium: "banner", hint: msg("Smart banner or button on your site. Ad group = the page.") },
  { id: "social_organic", label: msg("Social (organic)"), source: "instagram", medium: "social", hint: msg("Bio links and posts. Social in-app browsers get the Open-in-app page.") },
  { id: "paid", label: msg("Paid media / PPC"), source: "google", medium: "cpc", hint: msg("Search, social and display ads. Set Source to the network (google, meta, tiktok, snapchat) and fill Ad group and Creative from the ad.") },
] as const;
export type ChannelPreset = (typeof CHANNEL_PRESETS)[number];
