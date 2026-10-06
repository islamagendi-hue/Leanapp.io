import "server-only";
import { z } from "zod";
import { randomToken } from "@/lib/crypto";
import { isUniqueViolation, withSystem, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { hashIp } from "@/lib/secret-box";
import { envNumber } from "@/lib/env-number";
import { audit } from "@/modules/audit/service";
import { destinationFor, NETWORK_CLICK_IDS, parseQuery, parseUserAgent, type LinkDestinations, type Os } from "@/modules/attribution/pure";
import { assertSafeDestination } from "@/modules/attribution/url-safety";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { publicBaseUrl, publicLinkUrl } from "@/server/env";
import {
  ANDROID_PACKAGE, androidIntentUrl, buildAasa, buildAssetLinks, deepLinkPayload, DOMAIN, hostnameOf, inAppBrowser, interstitialCsp, interstitialHtml,
  IOS_APP_STORE_ID, IOS_BUNDLE_ID, IOS_TEAM_ID, iosSchemeUrl, linkBase, normalizeFingerprint, parseLinkPath, PREFIX_PATTERN, RESERVED_PREFIXES, URI_SCHEME,
  type AssociationConfig, type DeepLinkPayload,
} from "./pure";

/**
 * Deep linking (docs/deep-links.md):
 * - per-environment link domain configuration (iOS team / bundle ids, Android package
 *   and signing certificates) and the well-known files built from it;
 * - resolving a link an installed app was opened with (Universal Link / App Link),
 *   recording the open as a click so re-engagement is attributed;
 * - deferred deep links: the deep link of the click an install came from, once per install;
 * - the "Open in app" page for social in-app browsers.
 */

const issue = (e: z.ZodError) => new ValidationError(e.issues[0]?.message ?? "Invalid input.", Object.fromEntries(e.issues.map((i) => [i.path.join(".") || "form", i.message])));

export interface DeepLinkConfig {
  id: string;
  environment_id: string;
  link_prefix: string;
  custom_domain: string | null;
  ios_team_id: string | null;
  ios_bundle_ids: string[];
  ios_app_store_id: string | null;
  uri_scheme: string | null;
  android_package: string | null;
  android_sha256: string[];
  android_play_store_id: string | null;
  deferred_enabled: boolean;
  interstitial_enabled: boolean;
  last_check: WellKnownCheck[] | null;
  last_checked_at: Date | null;
  updated_at: Date;
}

const CONFIG_COLUMNS = `id, environment_id, link_prefix, custom_domain, ios_team_id, ios_bundle_ids, ios_app_store_id, uri_scheme, android_package, android_sha256,
  android_play_store_id, deferred_enabled, interstitial_enabled, last_check, last_checked_at, updated_at`;

/** Host links are served on by default (PUBLIC_LINK_URL), without port. */
export function defaultLinkHost(): string {
  return hostnameOf(publicLinkUrl())!;
}

/** Base URL of an environment's links. */
export function configLinkBase(config: Pick<DeepLinkConfig, "custom_domain"> | null): string {
  return linkBase(publicLinkUrl(), config?.custom_domain ?? null);
}

// ── Configuration (dashboard) ───────────────────────────────────────────────

export async function getConfig(ctx: TenantContext, appId: string, environmentId: string): Promise<DeepLinkConfig | null> {
  return tenantTx(ctx, "deep_links.read", (db) =>
    db.one<DeepLinkConfig>(`select ${CONFIG_COLUMNS} from platform.deep_link_configs where app_id = $1 and environment_id = $2`, [appId, environmentId]),
  );
}

/** A prefix suggestion: the app slug, with -dev / -stg for non-production environments. */
export function suggestPrefix(appSlug: string, envType: string): string {
  const base = appSlug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26) || "app";
  const suffix = envType === "production" ? "" : envType === "staging" ? "-stg" : "-dev";
  const s = `${base}${suffix}`;
  return s.length >= 3 ? s : `${s}-app`;
}

const formBool = z.union([z.boolean(), z.string()]).optional().transform((v) => v === true || v === "on" || v === "true" || v === "1");
const optional = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const list = (max: number) =>
  z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    [...new Set((Array.isArray(v) ? v : (v ?? "").split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))].slice(0, max + 1),
  );

const configSchema = z.object({
  environmentId: z.string().uuid("Choose an environment."),
  linkPrefix: z.string().trim().toLowerCase()
    .refine((v) => PREFIX_PATTERN.test(v), "Link prefix: 3–32 lowercase letters, digits or dashes (e.g. myapp or myapp-dev).")
    .refine((v) => !RESERVED_PREFIXES.has(v), "That link prefix is reserved. Pick another."),
  customDomain: optional(253).transform((v) => (v ? v.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null))
    .refine((v) => !v || DOMAIN.test(v), "Custom domain: a hostname like links.example.com (no path, no port)."),
  iosTeamId: optional(10).transform((v) => v?.toUpperCase() ?? null).refine((v) => !v || IOS_TEAM_ID.test(v), "Apple Team ID is 10 letters or digits (Membership details in your Apple developer account)."),
  iosBundleIds: list(10).refine((v) => v.length <= 10, "At most 10 bundle ids.").refine((v) => v.every((b) => IOS_BUNDLE_ID.test(b)), "Bundle ids look like com.example.app."),
  iosAppStoreId: optional(12).transform((v) => v?.replace(/^id/i, "") ?? null).refine((v) => !v || IOS_APP_STORE_ID.test(v), "App Store id is the number in your App Store URL (id123456789)."),
  uriScheme: optional(41).transform((v) => v?.toLowerCase().replace(/:\/*$/, "") ?? null)
    .refine((v) => !v || (URI_SCHEME.test(v) && !["http", "https", "javascript", "data", "file", "intent"].includes(v)), "URL scheme: letters, digits, + . - (e.g. myapp)."),
  androidPackage: optional(200).refine((v) => !v || ANDROID_PACKAGE.test(v), "Package name looks like com.example.app."),
  androidSha256: list(10).refine((v) => v.length <= 10, "At most 10 certificate fingerprints.")
    .transform((v, c) => v.map((f) => {
      const n = normalizeFingerprint(f);
      if (!n) c.addIssue({ code: "custom", message: "SHA-256 fingerprints are 32 bytes in hex (AB:CD:…), from Play Console → App integrity → App signing." });
      return n ?? "";
    })),
  androidPlayStoreId: optional(200).refine((v) => !v || ANDROID_PACKAGE.test(v), "Play Store id is the id= value of your Play listing (usually the package name)."),
  deferredEnabled: formBool,
  interstitialEnabled: formBool,
}).superRefine((c, ctx) => {
  if (c.iosBundleIds.length && !c.iosTeamId) ctx.addIssue({ code: "custom", path: ["iosTeamId"], message: "Add the Apple Team ID for the bundle ids." });
  if (c.iosTeamId && !c.iosBundleIds.length) ctx.addIssue({ code: "custom", path: ["iosBundleIds"], message: "Add at least one bundle id." });
  if (c.androidSha256.length && !c.androidPackage) ctx.addIssue({ code: "custom", path: ["androidPackage"], message: "Add the Android package name for the fingerprints." });
  if (c.androidPackage && !c.androidSha256.length) ctx.addIssue({ code: "custom", path: ["androidSha256"], message: "Add the app signing certificate SHA-256 fingerprint (App Links can't be verified without it)." });
});

export async function saveConfig(ctx: TenantContext, appId: string, input: unknown): Promise<DeepLinkConfig> {
  const r = configSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const c = r.data;
  if (c.customDomain) {
    const host = c.customDomain;
    if (host === defaultLinkHost() || host === hostnameOf(publicBaseUrl()) || /(^|\.)leanapp\.io$/.test(host)) {
      throw new ValidationError("Leave the custom domain empty to use the LeanApp link host.");
    }
    // A domain belongs to one organization: another org's apps must never be added to its association files.
    const taken = await withSystem((db) => db.one("select 1 from platform.deep_link_configs where custom_domain = $1 and organization_id <> $2 limit 1", [host, ctx.organizationId]));
    if (taken) throw new ValidationError("That domain is already used by another organization.");
  }
  return tenantTx(ctx, "deep_links.manage", async (db) => {
    const env = await db.one("select 1 from platform.environments where id = $1 and app_id = $2", [c.environmentId, appId]);
    if (!env) throw new NotFoundError("Environment");
    try {
      await db.query("savepoint dl_config");
      const row = await db.one<DeepLinkConfig>(
        `insert into platform.deep_link_configs (organization_id, app_id, environment_id, link_prefix, custom_domain, ios_team_id, ios_bundle_ids, ios_app_store_id,
                                                 uri_scheme, android_package, android_sha256, android_play_store_id, deferred_enabled, interstitial_enabled, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (environment_id) do update set link_prefix = excluded.link_prefix, custom_domain = excluded.custom_domain, ios_team_id = excluded.ios_team_id,
           ios_bundle_ids = excluded.ios_bundle_ids, ios_app_store_id = excluded.ios_app_store_id, uri_scheme = excluded.uri_scheme,
           android_package = excluded.android_package, android_sha256 = excluded.android_sha256, android_play_store_id = excluded.android_play_store_id,
           deferred_enabled = excluded.deferred_enabled, interstitial_enabled = excluded.interstitial_enabled, last_check = null, last_checked_at = null
         returning ${CONFIG_COLUMNS}`,
        [ctx.organizationId, appId, c.environmentId, c.linkPrefix, c.customDomain, c.iosTeamId, c.iosBundleIds, c.iosAppStoreId, c.uriScheme, c.androidPackage,
         c.androidSha256, c.androidPlayStoreId, c.deferredEnabled, c.interstitialEnabled, ctx.userId],
      );
      await db.query("release savepoint dl_config");
      await audit(db, {
        organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "deep_links.config_updated", targetType: "environment", targetId: c.environmentId,
        metadata: { link_prefix: c.linkPrefix, custom_domain: c.customDomain, ios_bundle_ids: c.iosBundleIds, android_package: c.androidPackage, deferred_enabled: c.deferredEnabled },
      });
      return row!;
    } catch (err) {
      await db.query("rollback to savepoint dl_config");
      if (isUniqueViolation(err)) throw new ValidationError("That link prefix is already taken. Pick another.", { linkPrefix: "That link prefix is already taken." });
      throw err;
    }
  });
}

// ── Well-known files ────────────────────────────────────────────────────────

/**
 * Association entries for a host: the environments whose links use it (their custom
 * domain, or the LeanApp link host when they have none). Empty for other hosts.
 */
export async function associationsForHost(host: string | null): Promise<AssociationConfig[]> {
  const h = hostnameOf(host);
  if (!h) return [];
  const isDefault = h === defaultLinkHost();
  const rows = await withSystem((db) =>
    db.query<AssociationConfig & { app_name: string; env_type: string }>(
      `select c.link_prefix, c.ios_team_id, c.ios_bundle_ids, c.android_package, c.android_sha256, a.name as app_name, e.type as env_type
         from platform.deep_link_configs c
         join platform.apps a on a.id = c.app_id
         join platform.environments e on e.id = c.environment_id
        where ${isDefault ? "(c.custom_domain is null or c.custom_domain = $1)" : "c.custom_domain = $1"}
        order by c.link_prefix`,
      [h],
    ),
  );
  return rows.map((r) => ({ ...r, label: `LeanApp links (${r.env_type})` }));
}

export async function aasaForHost(host: string | null) {
  return buildAasa(await associationsForHost(host));
}

export async function assetLinksForHost(host: string | null) {
  return buildAssetLinks(await associationsForHost(host));
}

export interface WellKnownCheck {
  file: "apple-app-site-association" | "assetlinks.json" | "apple-cdn";
  url: string;
  ok: boolean;
  /** Informational checks (Apple's CDN can lag a day) don't fail the configuration. */
  warning?: boolean;
  status: number | null;
  problems: string[];
}

async function fetchWellKnown(url: string, fetcher: typeof fetch): Promise<{ status: number | null; contentType: string; body: unknown; problems: string[] }> {
  const problems: string[] = [];
  try {
    await assertSafeDestination(url);
  } catch (err) {
    return { status: null, contentType: "", body: null, problems: [(err as Error).message] };
  }
  try {
    const res = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "LeanApp-DeepLinkCheck/1.0" } });
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (res.status >= 300 && res.status < 400) problems.push(`Redirects (HTTP ${res.status}) to ${res.headers.get("location") ?? "?"}: Apple and Android don't follow redirects for these files.`);
    else if (res.status !== 200) problems.push(`HTTP ${res.status}; it must be 200.`);
    if (res.status === 200 && !contentType.startsWith("application/json")) problems.push(`Content-Type is "${contentType || "missing"}"; it must be application/json.`);
    let body: unknown = null;
    if (res.status === 200) {
      const text = await res.text();
      if (text.length > 128_000) problems.push("The file is over 128 KB (Apple's limit).");
      try {
        body = JSON.parse(text);
      } catch {
        problems.push("The body is not valid JSON.");
      }
    }
    return { status: res.status, contentType, body, problems };
  } catch (err) {
    return { status: null, contentType: "", body: null, problems: [`Could not fetch it: ${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}.`] };
  }
}

/**
 * The dashboard's "Test" button: fetches both well-known files from the environment's
 * link host the way Apple and Google do (https, no redirects) and checks that they
 * list this environment's app ids for its link path. The result is stored on the config.
 */
export async function checkWellKnown(ctx: TenantContext, appId: string, environmentId: string, fetcher: typeof fetch = fetch): Promise<WellKnownCheck[]> {
  const config = await tenantTx(ctx, "deep_links.manage", (db) =>
    db.one<DeepLinkConfig>(`select ${CONFIG_COLUMNS} from platform.deep_link_configs where app_id = $1 and environment_id = $2`, [appId, environmentId]),
  );
  if (!config) throw new NotFoundError("Deep link configuration");
  const base = configLinkBase(config);
  const host = hostnameOf(base)!;
  const results: WellKnownCheck[] = [];

  if (config.ios_team_id && config.ios_bundle_ids.length) {
    const url = `${base}/.well-known/apple-app-site-association`;
    const r = await fetchWellKnown(url, fetcher);
    const details = ((r.body as { applinks?: { details?: { appIDs?: string[]; appID?: string; components?: { "/"?: string }[]; paths?: string[] }[] } })?.applinks?.details) ?? [];
    if (r.body !== null) {
      for (const bundle of config.ios_bundle_ids) {
        const appIdStr = `${config.ios_team_id}.${bundle}`;
        const entry = details.find((d) => d.appIDs?.includes(appIdStr) || d.appID === appIdStr);
        if (!entry) r.problems.push(`${appIdStr} is not listed.`);
        else if (!(entry.components ?? []).some((c) => c["/"] === `/l/${config.link_prefix}/*`) && !(entry.paths ?? []).includes(`/l/${config.link_prefix}/*`)) {
          r.problems.push(`${appIdStr} does not claim /l/${config.link_prefix}/*.`);
        }
      }
    }
    results.push({ file: "apple-app-site-association", url, ok: r.problems.length === 0, status: r.status, problems: r.problems });
    // What iOS devices actually download (Apple's CDN caches the file; changes can take up to a day).
    if (process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview") {
      const cdnUrl = `https://app-site-association.cdn-apple.com/a/v1/${host}`;
      const c = await fetchWellKnown(cdnUrl, fetcher);
      const listed = JSON.stringify(c.body ?? "").includes(`${config.ios_team_id}.${config.ios_bundle_ids[0]}`);
      if (c.body !== null && !listed) c.problems.push("Apple's cached copy doesn't list this app yet (Apple refreshes it within about 24 hours).");
      results.push({ file: "apple-cdn", url: cdnUrl, ok: c.problems.length === 0, warning: true, status: c.status, problems: c.problems.filter((p) => !p.startsWith("Content-Type")) });
    }
  }
  if (config.android_package && config.android_sha256.length) {
    const url = `${base}/.well-known/assetlinks.json`;
    const r = await fetchWellKnown(url, fetcher);
    if (r.body !== null) {
      const statements = Array.isArray(r.body) ? (r.body as { relation?: string[]; target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] } }[]) : [];
      if (!Array.isArray(r.body)) r.problems.push("assetlinks.json must be a JSON array.");
      const mine = statements.filter((s) => s.target?.namespace === "android_app" && s.target.package_name === config.android_package && s.relation?.includes("delegate_permission/common.handle_all_urls"));
      if (!mine.length) r.problems.push(`${config.android_package} is not listed with delegate_permission/common.handle_all_urls.`);
      for (const fp of config.android_sha256) {
        if (mine.length && !mine.some((s) => s.target?.sha256_cert_fingerprints?.includes(fp))) r.problems.push(`Fingerprint ${fp.slice(0, 11)}… is not listed.`);
      }
    }
    results.push({ file: "assetlinks.json", url, ok: r.problems.length === 0, status: r.status, problems: r.problems });
  }
  await tenantTx(ctx, "deep_links.manage", (db) =>
    db.query("update platform.deep_link_configs set last_check = $3, last_checked_at = now() where app_id = $1 and environment_id = $2", [appId, environmentId, JSON.stringify(results)]),
  );
  return results;
}

// ── Public link lookups ─────────────────────────────────────────────────────

interface LinkWithConfig extends LinkDestinations {
  id: string;
  organization_id: string;
  app_id: string;
  environment_id: string;
  name: string;
  status: "active" | "paused";
  app_name: string;
  config_prefix: string | null;
  custom_domain: string | null;
  ios_app_store_id: string | null;
  uri_scheme: string | null;
  android_package: string | null;
  android_play_store_id: string | null;
  interstitial_enabled: boolean | null;
  deferred_enabled: boolean | null;
}

const LINK_SELECT = `select l.id, l.organization_id, l.app_id, l.environment_id, l.code, l.name, l.source, l.medium, l.campaign, l.ad_group, l.creative,
        l.ios_url, l.android_url, l.web_url, l.deep_link_path, l.status, a.name as app_name,
        c.link_prefix as config_prefix, c.custom_domain, c.ios_app_store_id, c.uri_scheme, c.android_package, c.android_play_store_id,
        c.interstitial_enabled, c.deferred_enabled
   from platform.attribution_links l
   join platform.apps a on a.id = l.app_id
   left join platform.deep_link_configs c on c.environment_id = l.environment_id`;

async function linkByCode(db: Db, code: string): Promise<LinkWithConfig | null> {
  return db.one<LinkWithConfig>(`${LINK_SELECT} where l.code = $1`, [code]);
}

/** /l/{prefix}/{code}: the code must belong to the environment that owns the prefix. */
export async function prefixMatches(prefix: string, code: string): Promise<boolean> {
  if (!PREFIX_PATTERN.test(prefix) || !/^[A-Za-z0-9_-]{6,32}$/.test(code)) return false;
  const link = await withSystem((db) => linkByCode(db, code));
  return Boolean(link && link.config_prefix === prefix);
}

/**
 * The "Open in app" page for social in-app browsers (which keep Universal Links and
 * App Links inside the social app). Null when the visitor isn't in one, the link's
 * environment has no deep link configuration, or the page is turned off: the
 * caller then redirects as usual. `location` is the store / web URL the redirect
 * would have used (it carries the click id); `clickId` is the recorded click.
 */
export async function interstitialFor(
  code: string,
  req: { userAgent: string | null; acceptLanguage: string | null; location: string; clickId: string | null },
): Promise<{ html: string; csp: string } | null> {
  const browser = inAppBrowser(req.userAgent);
  if (!browser) return null;
  const link = await withSystem((db) => linkByCode(db, code));
  if (!link || !link.config_prefix || link.interstitial_enabled === false) return null;
  const { os } = parseUserAgent(req.userAgent);
  const base = linkBase(publicLinkUrl(), link.custom_domain);
  const appLink = `${base}/l/${link.config_prefix}/${link.code}${req.clickId ? `?click_id=${encodeURIComponent(req.clickId)}` : ""}`;
  let store = req.location;
  // Store fallbacks from the configuration when the link has no store URL for this platform.
  if (os === "ios" && !link.ios_url && link.ios_app_store_id) store = `https://apps.apple.com/app/id${link.ios_app_store_id}`;
  if (os === "android" && !link.android_url && (link.android_play_store_id || link.android_package)) {
    store = destinationFor({ ...link, android_url: `https://play.google.com/store/apps/details?id=${link.android_play_store_id ?? link.android_package}` }, "android", req.clickId);
  }
  let openUrl: string | null = null;
  if (os === "android" && link.android_package) openUrl = androidIntentUrl(appLink, link.android_package, store);
  if (os === "ios" && link.uri_scheme) {
    openUrl = iosSchemeUrl(link.uri_scheme, deepLinkPayload(link.deep_link_path, null), {
      click_id: req.clickId, utm_source: link.source, utm_medium: link.medium, utm_campaign: link.campaign, utm_term: link.ad_group, utm_content: link.creative,
    });
  }
  const nonce = randomToken(16);
  return {
    html: interstitialHtml({ appName: link.app_name, browser, os, openUrl, storeUrl: store, nonce, arabic: /^ar\b/i.test(req.acceptLanguage ?? "") }),
    csp: interstitialCsp(nonce),
  };
}

// ── Resolve (installed app opened with a link) ──────────────────────────────

export const RESOLVES_PER_ENVIRONMENT_PER_MINUTE = envNumber("DEEP_LINK_RESOLVES_PER_ENV_PER_MINUTE", 6000);
const RECORDS_PER_INSTALL_PER_LINK_PER_MINUTE = 20;

export interface ResolvedDeepLink {
  link: { code: string; name: string };
  deep_link: DeepLinkPayload;
  campaign: { source: string; medium: string | null; campaign: string | null; ad_group: string | null; creative: string | null };
  click_id: string | null;
  is_deferred: boolean;
  match_type: "deterministic" | "probabilistic" | null;
}

const resolveSchema = z.object({
  url: z.string().trim().min(1, "url is required.").max(2000, "url is too long."),
  anonymous_id: z.string().trim().max(200).optional().transform((v) => v || null),
  platform: z.enum(["ios", "android", "react_native", "flutter", "web"]).optional(),
});

function requestOs(platform: string | undefined, ua: string | null): { os: Os; major: string | null } {
  const parsed = parseUserAgent(ua);
  if (platform === "ios" || platform === "android") return { os: platform, major: parsed.os === platform ? parsed.major : null };
  return parsed;
}

/**
 * GET /v1/deep-links/resolve: an installed app was opened with one of the environment's
 * links. Returns the link's deep link and campaign, and records the open as a click
 * touchpoint (or reuses the click already recorded by the redirect / interstitial when
 * the URL carries its click_id). The SDK then sends `deep_link_opened` with that
 * click id, which the attribution engine records as a re-engagement.
 * Links of another environment or organization are "not found".
 */
export async function resolveLink(
  key: IngestionPrincipal,
  input: unknown,
  req: { ip: string | null; userAgent: string | null },
): Promise<ResolvedDeepLink> {
  const r = resolveSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  let url: URL;
  try {
    url = new URL(r.data.url);
  } catch {
    throw new ValidationError("url is not a valid URL.");
  }
  const parsed = /^https?:$/.test(url.protocol) ? parseLinkPath(url.pathname) : null;
  if (!parsed) throw new NotFoundError("Link");
  const link = await withSystem((db) => linkByCode(db, parsed.code));
  // Environment isolation: a key only resolves its own environment's links.
  if (!link || link.environment_id !== key.environmentId) throw new NotFoundError("Link");
  if (parsed.prefix && parsed.prefix !== link.config_prefix) throw new NotFoundError("Link");
  const host = url.hostname.toLowerCase();
  const hosts = new Set([defaultLinkHost(), hostnameOf(publicBaseUrl()), link.custom_domain].filter(Boolean));
  if (!hosts.has(host)) throw new NotFoundError("Link");

  const q = (k: string) => url.searchParams.get(k)?.trim().slice(0, 100) || null;
  const campaign = {
    source: link.source,
    medium: link.medium,
    campaign: q("utm_campaign") ?? q("campaign") ?? link.campaign,
    ad_group: q("utm_term") ?? q("ad_group") ?? link.ad_group,
    creative: q("utm_content") ?? q("creative") ?? link.creative,
  };
  const anonymousId = r.data.anonymous_id;
  const clickId = await withSystem(async (db) => {
    // A click recorded by the redirect or the interstitial: reuse it.
    const given = url.searchParams.get("click_id");
    if (given && /^lac_[A-Za-z0-9_-]{8,64}$/.test(given)) {
      const existing = await db.one<{ click_id: string }>(
        `update platform.attribution_touchpoints set anonymous_id = coalesce(anonymous_id, $3)
          where environment_id = $1 and click_id = $2 and link_id = $4 and kind = 'click' returning click_id`,
        [key.environmentId, given, anonymousId, link.id],
      );
      if (existing) return existing.click_id;
    }
    if (link.status !== "active") return null;
    const ipHash = hashIp(link.app_id, req.ip);
    if (await consumeRateLimit(`dlclick:${link.id}:${anonymousId ?? ipHash ?? req.ip ?? "unknown"}`, RECORDS_PER_INSTALL_PER_LINK_PER_MINUTE, 60)) return null;
    let network: { param: string; value: string; network: string } | null = null;
    for (const [param, net] of Object.entries(NETWORK_CLICK_IDS)) {
      const v = url.searchParams.get(param)?.trim();
      if (v) {
        network = { param: param === "sccid" ? "ScCid" : param, value: v.slice(0, 500), network: net };
        break;
      }
    }
    const { os, major } = requestOs(r.data.platform, req.userAgent);
    const id = `lac_${randomToken(16)}`;
    await db.query(
      `insert into platform.attribution_touchpoints
         (organization_id, app_id, environment_id, anonymous_id, provider, kind, link_id, source, medium, campaign, ad_group, creative, click_id,
          network_click_id, network, landing_page, touchpoint_at, ip_hash, user_agent, os_name, os_major, raw)
       values ($1, $2, $3, $4, 'link', 'click', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), $15, $16, $17, $18, $19)`,
      [link.organization_id, link.app_id, link.environment_id, anonymousId, link.id, link.source, link.medium, campaign.campaign, campaign.ad_group, campaign.creative,
       id, network?.value ?? null, network?.network ?? null, url.toString().slice(0, 1000), ipHash, req.userAgent?.slice(0, 512) ?? null, os, major,
       JSON.stringify({ via: "app_link", ...(network ? { network_click_param: network.param } : {}) })],
    );
    return id;
  });
  return {
    link: { code: link.code, name: link.name },
    deep_link: deepLinkPayload(link.deep_link_path, url.searchParams),
    campaign,
    click_id: clickId,
    is_deferred: false,
    match_type: null,
  };
}

// ── Deferred deep links (first open after install) ──────────────────────────

const deferredSchema = z.object({
  anonymous_id: z.string().trim().min(1, "anonymous_id is required.").max(200),
  install_referrer: z.string().max(2000).optional().transform((v) => v || null),
  click_id: z.string().trim().max(100).optional().transform((v) => v || null),
  platform: z.enum(["ios", "android", "react_native", "flutter", "web"]).optional(),
  os: z.enum(["ios", "android"]).optional(),
  os_version: z.string().trim().max(40).optional().transform((v) => v || null),
});

export interface DeferredDeepLink {
  match_type: "deterministic" | "probabilistic" | "none";
  /** Why nothing matched: no_click, already_checked, disabled. */
  reason?: string;
  match_key?: string;
  link?: { code: string; name: string };
  deep_link: DeepLinkPayload | null;
  campaign?: ResolvedDeepLink["campaign"];
  click_id?: string | null;
  is_deferred: true;
}

interface CandidateClick {
  id: string;
  click_id: string;
  link_id: string;
  campaign: string | null;
  ad_group: string | null;
  creative: string | null;
}

/**
 * POST /v1/deep-links/deferred: the deep link of the click this install came from,
 * answered once per install (anonymous_id) and handing each click to one install only.
 *   1. deterministic: the LeanApp click id in the Play install referrer (or one the app
 *      passes from its own channel), clicked within the click lookback;
 *   2. probabilistic: only when the app turned probabilistic matching on in attribution
 *      settings, only Android, same keyed IP hash and Android version within the
 *      probabilistic window, unclaimed clicks only. Labelled "probabilistic".
 * Only the key's environment is searched.
 */
export async function deferredDeepLink(key: IngestionPrincipal, input: unknown, req: { ip: string | null }): Promise<DeferredDeepLink> {
  const r = deferredSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const b = r.data;
  return withSystem(async (db) => {
    const cfg = await db.one<{ deferred_enabled: boolean }>("select deferred_enabled from platform.deep_link_configs where environment_id = $1", [key.environmentId]);
    if (cfg && !cfg.deferred_enabled) return { match_type: "none", reason: "disabled", deep_link: null, is_deferred: true };
    const prior = await db.one("select 1 from platform.deep_link_deferred_matches where environment_id = $1 and anonymous_id = $2", [key.environmentId, b.anonymous_id]);
    if (prior) return { match_type: "none", reason: "already_checked", deep_link: null, is_deferred: true };

    const settings = (await db.one<{ click_lookback_days: number; probabilistic_enabled: boolean; probabilistic_window_hours: number }>(
      "select click_lookback_days, probabilistic_enabled, probabilistic_window_hours from platform.attribution_settings where app_id = $1",
      [key.appId],
    )) ?? { click_lookback_days: 7, probabilistic_enabled: false, probabilistic_window_hours: 24 };

    const tpColumns = "t.id, t.click_id, t.link_id, t.campaign, t.ad_group, t.creative";
    let candidate: CandidateClick | null = null;
    let matchType: "deterministic" | "probabilistic" = "deterministic";
    let matchKey = "";
    const ours = (v: string | null | undefined) => (v && /^lac_[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
    const fromReferrer = ours(parseQuery(b.install_referrer).click_id);
    const clickId = fromReferrer ?? ours(b.click_id);
    if (clickId) {
      candidate = await db.one<CandidateClick>(
        `select ${tpColumns} from platform.attribution_touchpoints t
          where t.environment_id = $1 and t.click_id = $2 and t.kind = 'click' and t.link_id is not null
            and t.touchpoint_at >= now() - make_interval(days => $3)`,
        [key.environmentId, clickId, settings.click_lookback_days],
      );
      matchKey = fromReferrer ? "install_referrer" : "click_id";
    }
    const os = b.os ?? (b.platform === "ios" || b.platform === "android" ? b.platform : null);
    const ipHash = hashIp(key.appId, req.ip);
    if (!candidate && !clickId && settings.probabilistic_enabled && os === "android" && ipHash && key.kind === "sdk") {
      const major = /^(\d+)/.exec(b.os_version ?? "")?.[1] ?? null;
      candidate = await db.one<CandidateClick>(
        `select ${tpColumns} from platform.attribution_touchpoints t
          where t.environment_id = $1 and t.ip_hash = $2 and t.kind = 'click' and t.os_name = 'android' and t.link_id is not null
            and ($3::text is null or t.os_major is null or t.os_major = $3)
            and t.touchpoint_at >= now() - make_interval(hours => $4)
            and not exists (select 1 from platform.deep_link_deferred_matches m where m.touchpoint_id = t.id)
          order by t.touchpoint_at desc limit 1`,
        [key.environmentId, ipHash, major, Math.min(settings.probabilistic_window_hours, 24 * 7)],
      );
      matchType = "probabilistic";
      matchKey = "ip_os";
    }

    const record = (tp: CandidateClick | null) =>
      db.one<{ id: string }>(
        `insert into platform.deep_link_deferred_matches (organization_id, app_id, environment_id, anonymous_id, touchpoint_id, link_id, match_type, match_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning id`,
        [key.organizationId, key.appId, key.environmentId, b.anonymous_id, tp?.id ?? null, tp?.link_id ?? null, tp ? matchType : "none", tp ? matchKey : null],
      );
    if (!candidate) {
      const row = await record(null);
      return { match_type: "none", reason: row ? "no_click" : "already_checked", deep_link: null, is_deferred: true };
    }
    if (!(await record(candidate))) {
      // Either this install raced itself or another install already received this click.
      const mine = await db.one("select 1 from platform.deep_link_deferred_matches where environment_id = $1 and anonymous_id = $2", [key.environmentId, b.anonymous_id]);
      if (!mine) await record(null);
      return { match_type: "none", reason: mine ? "already_checked" : "no_click", deep_link: null, is_deferred: true };
    }
    const link = (await db.one<LinkWithConfig>(`${LINK_SELECT} where l.id = $1`, [candidate.link_id]))!;
    return {
      match_type: matchType,
      match_key: matchKey,
      link: { code: link.code, name: link.name },
      deep_link: link.deep_link_path ? deepLinkPayload(link.deep_link_path, null) : null,
      campaign: { source: link.source, medium: link.medium, campaign: candidate.campaign, ad_group: candidate.ad_group, creative: candidate.creative },
      click_id: candidate.click_id,
      is_deferred: true,
    };
  });
}
