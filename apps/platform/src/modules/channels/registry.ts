/**
 * The growth channel registry: one list of every acquisition, owned and
 * partner channel LeanApp reports on, with how a touch is recognised as that
 * channel. Pure and client-safe; unit-tested in registry.test.ts.
 *
 * Concepts kept apart (docs/channels.md):
 *   channel        where a person came from or was reached (meta, organic_search, whatsapp, qr, …)
 *   data source    what told us (a tracking-link click, the install's own context, a web touch, a provider report)
 *   provider       the company behind a channel (Meta, Google); connections and capabilities live in
 *                  modules/integrations (ad platforms) and modules/messaging (owned channels), not here
 *
 * Three channels have no source behind them and are never merged:
 *   direct        the touch was observed and says it had no referrer or campaign ("(direct)", utm_source=direct)
 *   unknown       the touch carried a source no rule recognises
 *   unattributed  nothing was observed or matched (no touch, no campaign data, no click)
 * None of the three is organic: organic is only claimed when the data says so (an organic store
 * referrer, a search engine or social referrer, utm_medium=organic).
 */
import { msg } from "@/i18n/translate";

export const CHANNEL_GROUPS = ["paid", "organic", "owned", "referral", "custom", "none"] as const;
export type ChannelGroup = (typeof CHANNEL_GROUPS)[number];

export const GROUP_LABELS: Record<ChannelGroup, string> = {
  paid: msg("Paid"),
  organic: msg("Organic"),
  owned: msg("Owned and lifecycle"),
  referral: msg("Referral, partners and offline"),
  custom: msg("Custom"),
  none: msg("No source"),
};

/** Ad-network click id parameters and the paid channel each belongs to. */
export const CLICK_ID_CHANNELS: Record<string, string> = {
  gclid: "google_ads",
  gbraid: "google_ads",
  wbraid: "google_ads",
  dclid: "google_ads",
  fbclid: "meta_ads",
  ttclid: "tiktok_ads",
  ScCid: "snapchat_ads",
  sccid: "snapchat_ads",
  twclid: "x_ads",
  msclkid: "microsoft_ads",
  li_fat_id: "linkedin_ads",
  epik: "pinterest_ads",
};

export interface ChannelDef {
  /** Stable key, stored in reports and custom rules. */
  key: string;
  group: ChannelGroup;
  /** msg()-marked label, or a brand name. */
  label: string;
  /**
   * Source values (lower case, letters and digits only after normalising) that mean this channel.
   * A source matches when it equals an alias or starts with one followed by a separator.
   */
  sources?: readonly string[];
  /** Medium values that mean this channel whatever the source (owned channels: email, sms…). */
  mediums?: readonly string[];
  /** Referrer hostnames (suffix match) that mean this channel when there is no campaign data. */
  referrers?: readonly string[];
  /**
   * Network key stored on touchpoints and attributions (attribution_touchpoints.network); the
   * postback adapters in modules/attribution/networks.ts exist for meta, google, tiktok and snapchat.
   */
  network?: string;
  /** Default source / medium for a tracking link made for the channel. */
  link?: { source: string; medium: string; hint: string };
}

/** Mediums that say a touch was paid for. */
export const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paid", "paidsearch", "paidsocial", "paid_social", "paid_search", "cpm", "cpa", "cpi", "cpv", "display", "banner_ad", "video_ad",
  "ads", "ad", "sem", "app", "app_campaign", "uac", "retargeting", "remarketing", "programmatic",
]);
/** Mediums that say a touch was organic social. */
const SOCIAL_MEDIUMS = new Set(["social", "organic_social", "social_organic", "post", "bio", "story", "reel"]);

const SEARCH_ENGINES = ["google.", "bing.com", "yahoo.", "duckduckgo.com", "yandex.", "baidu.com", "ecosia.org", "search.brave.com", "naver.com", "seznam.cz"];
const SOCIAL_SITES = [
  "facebook.com", "fb.com", "instagram.com", "l.instagram.com", "lm.facebook.com", "t.co", "x.com", "twitter.com", "tiktok.com", "snapchat.com",
  "linkedin.com", "lnkd.in", "pinterest.com", "pin.it", "youtube.com", "youtu.be", "reddit.com", "threads.net", "telegram.org", "t.me",
];

/**
 * Built-in channels. Order matters only for readability; matching order is
 * defined in classify.ts (custom rules, click ids, source + medium, referrer).
 */
export const BUILT_IN_CHANNELS: readonly ChannelDef[] = [
  // ── Paid ──
  { key: "meta_ads", group: "paid", label: "Meta (Facebook, Instagram)", sources: ["meta", "facebook", "fb", "instagram", "ig", "messenger", "audiencenetwork", "an"], network: "meta",
    link: { source: "meta", medium: "paid_social", hint: msg("Facebook and Instagram ads. Meta appends fbclid to the link.") } },
  { key: "google_ads", group: "paid", label: "Google Ads", sources: ["google", "googleads", "adwords", "youtube", "gads", "uac", "googleapp"], network: "google",
    link: { source: "google", medium: "cpc", hint: msg("Search, YouTube, display and app campaigns. Google appends gclid, gbraid or wbraid; app campaigns report most installs to Google, not to links.") } },
  { key: "tiktok_ads", group: "paid", label: "TikTok Ads", sources: ["tiktok", "tiktokads", "pangle"], network: "tiktok",
    link: { source: "tiktok", medium: "paid_social", hint: msg("TikTok appends ttclid to the link.") } },
  { key: "snapchat_ads", group: "paid", label: "Snapchat Ads", sources: ["snapchat", "snap"], network: "snapchat",
    link: { source: "snapchat", medium: "paid_social", hint: msg("Snapchat appends ScCid to the link.") } },
  { key: "apple_search_ads", group: "paid", label: "Apple Search Ads", sources: ["applesearchads", "asa", "searchads", "appleads"],
    link: { source: "apple_search_ads", medium: "cpc", hint: msg("Apple Search Ads installs are reported by Apple's AdServices API: LeanApp looks up the token the iOS SDK sends and stores Apple's answer (Settings → Integrations). A link only covers web traffic.") } },
  { key: "linkedin_ads", group: "paid", label: "LinkedIn Ads", sources: ["linkedin", "linkedinads"], network: "linkedin",
    link: { source: "linkedin", medium: "paid_social", hint: msg("LinkedIn appends li_fat_id when enabled in Campaign Manager.") } },
  { key: "pinterest_ads", group: "paid", label: "Pinterest Ads", sources: ["pinterest", "pinterestads"], network: "pinterest",
    link: { source: "pinterest", medium: "paid_social", hint: msg("Pinterest appends epik to the link.") } },
  { key: "x_ads", group: "paid", label: "X Ads", sources: ["x", "twitter", "xads", "twitterads"], network: "x",
    link: { source: "x", medium: "paid_social", hint: msg("X appends twclid to the link.") } },
  { key: "microsoft_ads", group: "paid", label: "Microsoft Ads", sources: ["bing", "microsoft", "msads", "microsoftads"], network: "microsoft",
    link: { source: "microsoft", medium: "cpc", hint: msg("Microsoft Ads appends msclkid to the link.") } },
  // ── Organic ──
  { key: "organic_search", group: "organic", label: msg("Organic search"), referrers: SEARCH_ENGINES },
  { key: "organic_social", group: "organic", label: msg("Organic social"), referrers: SOCIAL_SITES,
    link: { source: "instagram", medium: "social", hint: msg("Bio links and posts. Social in-app browsers get the Open-in-app page.") } },
  { key: "content", group: "organic", label: msg("Content and SEO"), sources: ["blog", "seo", "content"], mediums: ["content", "blog", "seo", "article"],
    link: { source: "blog", medium: "content", hint: msg("Articles, guides and SEO pages. Campaign = the article.") } },
  { key: "app_store", group: "organic", label: msg("App Store and Google Play discovery"), sources: ["appstore", "googleplay", "playstore", "apple", "itunes"],
    referrers: ["apps.apple.com", "play.google.com", "itunes.apple.com"] },
  { key: "referral_site", group: "organic", label: msg("Referral sites"), mediums: ["referral"] },
  // ── Owned and lifecycle (ids match modules/messaging channel ids) ──
  { key: "whatsapp", group: "owned", label: "WhatsApp", sources: ["whatsapp", "wa"], mediums: ["whatsapp", "messaging"],
    link: { source: "whatsapp", medium: "messaging", hint: msg("Broadcasts and click-to-chat. WhatsApp shows a preview: previews are not counted as clicks.") } },
  { key: "email", group: "owned", label: msg("Email"), sources: ["email", "newsletter"], mediums: ["email", "newsletter"],
    link: { source: "email", medium: "email", hint: msg("Newsletter or lifecycle email. Campaign = the email or flow name.") } },
  { key: "sms", group: "owned", label: msg("SMS"), sources: ["sms"], mediums: ["sms", "text"],
    link: { source: "sms", medium: "sms", hint: msg("Keep the link short; the deep link opens the app directly when installed.") } },
  { key: "push", group: "owned", label: msg("Mobile push"), sources: ["push"], mediums: ["push", "push_notification"],
    link: { source: "push", medium: "push", hint: msg("Mobile push notifications that open a link.") } },
  { key: "web_push", group: "owned", label: msg("Web push"), sources: ["webpush"], mediums: ["web_push", "webpush"] },
  { key: "in_app", group: "owned", label: msg("In-app messages"), sources: ["inapp"], mediums: ["in_app", "inapp"] },
  { key: "website", group: "owned", label: msg("Website, forms and landing pages"), sources: ["website", "web", "site", "landing"], mediums: ["banner", "website", "form", "landing_page"],
    link: { source: "website", medium: "banner", hint: msg("Smart banner, form or button on your site. Ad group = the page.") } },
  // ── Referral, partners and offline ──
  { key: "referral_program", group: "referral", label: msg("Referral program and invites"), sources: ["referral", "invite", "refer"], mediums: ["invite", "referral_program", "refer_a_friend"],
    link: { source: "referral", medium: "invite", hint: msg("Invite links from your referral program. Creative = the referrer's code.") } },
  { key: "affiliate", group: "referral", label: msg("Affiliates"), sources: ["affiliate"], mediums: ["affiliate"],
    link: { source: "affiliate", medium: "affiliate", hint: msg("One link per affiliate: put the affiliate id in Creative.") } },
  { key: "influencer", group: "referral", label: msg("Influencers and creators"), sources: ["influencer", "creator"], mediums: ["influencer", "creator"],
    link: { source: "influencer", medium: "influencer", hint: msg("One link per creator: put the handle in Creative.") } },
  { key: "partner", group: "referral", label: msg("Partners"), sources: ["partner"], mediums: ["partner", "partnership", "cobrand"],
    link: { source: "partner", medium: "partner", hint: msg("Co-marketing and partner placements. Creative = the partner.") } },
  { key: "qr", group: "referral", label: msg("QR codes"), sources: ["qr", "qrcode"], mediums: ["qr", "offline", "print"],
    link: { source: "qr", medium: "offline", hint: msg("Print, packaging, in-store. Use the creative field for the placement (e.g. riyadh_mall_poster).") } },
  { key: "store_pos", group: "referral", label: msg("Physical stores and POS"), sources: ["store", "pos", "instore", "retail"], mediums: ["pos", "in_store", "retail"],
    link: { source: "store", medium: "pos", hint: msg("Receipts, tills and in-store screens. Creative = the branch.") } },
  { key: "event", group: "referral", label: msg("Events"), sources: ["event", "expo", "conference"], mediums: ["event", "booth"],
    link: { source: "event", medium: "event", hint: msg("Booths, talks and sponsorships. Campaign = the event.") } },
  { key: "call_center", group: "referral", label: msg("Call center"), sources: ["callcenter", "phone", "call"], mediums: ["call_center", "phone", "call"],
    link: { source: "call_center", medium: "call_center", hint: msg("Links sent by agents after a call.") } },
  { key: "manual", group: "referral", label: msg("Manual sources"), sources: ["manual"], mediums: ["manual"] },
  // ── No source ──
  { key: "direct", group: "none", label: msg("Direct") },
  { key: "unknown", group: "none", label: msg("Unknown source") },
  { key: "unattributed", group: "none", label: msg("Unattributed") },
];

export const SYSTEM_CHANNELS = { direct: "direct", unknown: "unknown", unattributed: "unattributed" } as const;

/** Letters and digits only, for alias matching ("Google Play" → "googleplay", "tik-tok" → "tiktok"). */
export function compact(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The built-in channel a source names: the whole source ("google-play" → googleplay) first, then its first word ("facebook_ads" → facebook). */
export function channelBySource(source: string | null | undefined): ChannelDef | undefined {
  const whole = compact(source);
  if (!whole) return undefined;
  const exact = BUILT_IN_CHANNELS.find((d) => d.sources?.includes(whole));
  if (exact) return exact;
  const word = compact(source!.split(/[^a-z0-9]/i)[0]);
  return word && word !== whole ? BUILT_IN_CHANNELS.find((d) => d.sources?.includes(word)) : undefined;
}

/** Attribution network of a paid source name (tiktok, fb, instagram, google…), else null. */
export function networkOfSource(source: string | null | undefined): string | null {
  const def = channelBySource(source);
  return def?.group === "paid" ? def.network ?? null : null;
}

/** Click id parameter → attribution network (gclid → google, fbclid → meta…). */
export const CLICK_ID_NETWORKS: Record<string, string> = Object.fromEntries(
  Object.entries(CLICK_ID_CHANNELS).map(([param, key]) => [param, BUILT_IN_CHANNELS.find((c) => c.key === key)!.network!]),
);

/** Attribution network → paid channel. */
export const NETWORK_CHANNELS: Record<string, string> = Object.fromEntries(
  BUILT_IN_CHANNELS.filter((c) => c.group === "paid" && c.network).map((c) => [c.network!, c.key]),
);

const BY_KEY = new Map(BUILT_IN_CHANNELS.map((c) => [c.key, c]));

export function builtInChannel(key: string): ChannelDef | undefined {
  return BY_KEY.get(key);
}

/** Custom channel keys: lower-case snake case, prefixed so they never collide with built-ins. */
export const CUSTOM_KEY = /^custom_[a-z0-9_]{1,40}$/;

/** A customer-defined channel (platform.channel_definitions). */
export interface CustomChannel {
  key: string;
  label: string;
  group: Exclude<ChannelGroup, "none">;
}

/** Label and group of a channel key, built-in or custom; unknown keys fall back to the key itself under "custom". */
export function channelInfo(key: string, custom: readonly CustomChannel[] = []): { key: string; label: string; group: ChannelGroup; builtIn: boolean } {
  const b = BY_KEY.get(key);
  if (b) return { key, label: b.label, group: b.group, builtIn: true };
  const c = custom.find((x) => x.key === key);
  return c ? { key, label: c.label, group: c.group, builtIn: false } : { key, label: key, group: "custom", builtIn: false };
}

/** Tracking-link presets for the channels that have one (Deep links and Tracking links forms). */
export const LINK_PRESETS = BUILT_IN_CHANNELS.filter((c): c is ChannelDef & { link: NonNullable<ChannelDef["link"]> } => Boolean(c.link)).map((c) => ({
  id: c.key,
  group: c.group,
  label: c.label,
  source: c.link.source,
  medium: c.link.medium,
  hint: c.link.hint,
}));
export type LinkPreset = (typeof LINK_PRESETS)[number];

/** Old Deep links preset ids (before the registry) and the channel each now is. */
export const LEGACY_PRESET_IDS: Record<string, string> = { paid: "google_ads", web_banner: "website", social_organic: "organic_social" };

export function linkPreset(id: string | null | undefined): LinkPreset | undefined {
  if (!id) return undefined;
  const key = LEGACY_PRESET_IDS[id] ?? id;
  return LINK_PRESETS.find((p) => p.id === key);
}

/** Labels that mean "no paid source": spend can't be put on these (ad spend validation). */
export const NON_SPEND_SOURCES = new Set(["organic", "(unknown)", "(no install on record)", "(none)", "direct", "(direct)", "unknown", "unattributed", "(unattributed)", "none", "not set", "(not set)"]);

export { SEARCH_ENGINES, SOCIAL_MEDIUMS, SOCIAL_SITES };
