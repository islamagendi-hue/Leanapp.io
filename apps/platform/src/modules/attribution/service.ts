import "server-only";
import { z } from "zod";
import { randomToken } from "@/lib/crypto";
import { isUniqueViolation, withSystem, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { encryptionAvailable, encryptSecret, hashIp } from "@/lib/secret-box";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { DEFAULT_SETTINGS, type AttributionSettings } from "./engine";
import { NETWORK_SPECS, NETWORKS, type Network } from "./networks";
import { destinationFor, isBot, isPrefetch, NETWORK_CLICK_IDS, parseUserAgent, unknownMacros, type LinkDestinations } from "./pure";
import { assertPostbackUrlShape } from "./url-safety";

const issue = (e: z.ZodError) => new ValidationError(e.issues[0]?.message ?? "Invalid input.", Object.fromEntries(e.issues.map((i) => [i.path.join(".") || "form", i.message])));

async function assertEnvironment(db: Db, appId: string, environmentId: string) {
  const env = await db.one<{ id: string }>("select id from platform.environments where id = $1 and app_id = $2", [environmentId, appId]);
  if (!env) throw new NotFoundError("Environment");
}

// ── Settings ────────────────────────────────────────────────────────────────
export async function getSettings(ctx: TenantContext, appId: string): Promise<AttributionSettings & { view_lookback_hours: number }> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const row = await db.one<AttributionSettings & { view_lookback_hours: number }>(
      `select click_lookback_days, view_lookback_hours, probabilistic_enabled, probabilistic_window_hours, conversion_window_days, reengagement_enabled
         from platform.attribution_settings where app_id = $1`,
      [appId],
    );
    return row ?? { ...DEFAULT_SETTINGS, view_lookback_hours: 24 };
  });
}

const formBool = z.union([z.boolean(), z.string()]).optional().transform((v) => v === true || v === "on" || v === "true" || v === "1");
const settingsSchema = z.object({
  clickLookbackDays: z.coerce.number().int().min(1, "Click lookback is 1–90 days.").max(90, "Click lookback is 1–90 days."),
  probabilisticEnabled: formBool,
  probabilisticWindowHours: z.coerce.number().int().min(1, "Probabilistic window is 1–168 hours.").max(168, "Probabilistic window is 1–168 hours."),
  conversionWindowDays: z.coerce.number().int().min(1, "Conversion window is 1–730 days.").max(730, "Conversion window is 1–730 days."),
  reengagementEnabled: formBool,
});

export async function updateSettings(ctx: TenantContext, appId: string, input: unknown): Promise<void> {
  const r = settingsSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const s = r.data;
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const app = await db.one("select 1 from platform.apps where id = $1", [appId]);
    if (!app) throw new NotFoundError("App");
    await db.query(
      `insert into platform.attribution_settings (organization_id, app_id, click_lookback_days, probabilistic_enabled, probabilistic_window_hours,
                                                  conversion_window_days, reengagement_enabled, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (app_id) do update set click_lookback_days = excluded.click_lookback_days, probabilistic_enabled = excluded.probabilistic_enabled,
         probabilistic_window_hours = excluded.probabilistic_window_hours, conversion_window_days = excluded.conversion_window_days,
         reengagement_enabled = excluded.reengagement_enabled, updated_at = now()`,
      [ctx.organizationId, appId, s.clickLookbackDays, s.probabilisticEnabled, s.probabilisticWindowHours, s.conversionWindowDays, s.reengagementEnabled],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.settings_updated", targetType: "app", targetId: appId, metadata: s });
  });
}

// ── Links ───────────────────────────────────────────────────────────────────
const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const httpsUrl = (label: string) =>
  z.string().trim().max(2000).optional().transform((v) => v || null)
    .refine((v) => {
      if (!v) return true;
      try {
        const u = new URL(v);
        return u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
      } catch {
        return false;
      }
    }, `${label} must be an https:// URL.`);

const linkSchema = z
  .object({
    environmentId: z.string().uuid("Choose an environment."),
    name: z.string().trim().min(1, "Name the link.").max(120),
    source: z.string().trim().min(1, "Source is required (e.g. tiktok, snapchat, google, instagram).").max(100),
    medium: opt(100),
    campaign: opt(100),
    adGroup: opt(100),
    creative: opt(100),
    iosUrl: httpsUrl("App Store URL"),
    androidUrl: httpsUrl("Play Store URL"),
    webUrl: httpsUrl("Web fallback URL"),
    deepLinkPath: opt(500).refine((v) => !v || (/^(\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(v) && !/^(javascript|data|vbscript):/i.test(v)), "Deep link must be a path (/product/123) or an app URL (myapp://…)."),
  })
  .refine((l) => l.iosUrl || l.androidUrl || l.webUrl, { message: "Add at least one destination.", path: ["iosUrl"] });

export interface LinkRow extends LinkDestinations {
  id: string;
  environment_id: string;
  name: string;
  status: "active" | "paused";
  created_at: Date;
}

const LINK_COLUMNS = "id, environment_id, code, name, source, medium, campaign, ad_group, creative, ios_url, android_url, web_url, deep_link_path, status, created_at";

export async function createLink(ctx: TenantContext, appId: string, input: unknown): Promise<LinkRow> {
  const r = linkSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const l = r.data;
  return tenantTx(ctx, "attribution.manage", async (db) => {
    await assertEnvironment(db, appId, l.environmentId);
    for (let attempt = 0; ; attempt++) {
      const code = randomToken(6); // 8 url-safe characters
      try {
        await db.query("savepoint link");
        const row = await db.one<LinkRow>(
          `insert into platform.attribution_links (organization_id, app_id, environment_id, code, name, source, medium, campaign, ad_group, creative,
                                                   ios_url, android_url, web_url, deep_link_path, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           returning ${LINK_COLUMNS}`,
          [ctx.organizationId, appId, l.environmentId, code, l.name, l.source, l.medium, l.campaign, l.adGroup, l.creative, l.iosUrl, l.androidUrl, l.webUrl, l.deepLinkPath, ctx.userId],
        );
        await db.query("release savepoint link");
        await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.link_created", targetType: "attribution_link", targetId: row!.id, metadata: { code, environment_id: l.environmentId, source: l.source, campaign: l.campaign } });
        return row!;
      } catch (err) {
        await db.query("rollback to savepoint link");
        if (!isUniqueViolation(err) || attempt >= 3) throw err;
      }
    }
  });
}

export async function setLinkStatus(ctx: TenantContext, appId: string, linkId: string, status: "active" | "paused"): Promise<void> {
  if (!z.string().uuid().safeParse(linkId).success || !["active", "paused"].includes(status)) throw new ValidationError("Invalid link.");
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = await db.one("update platform.attribution_links set status = $3 where id = $1 and app_id = $2 returning id", [linkId, appId, status]);
    if (!row) throw new NotFoundError("Link");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.link_updated", targetType: "attribution_link", targetId: linkId, metadata: { status } });
  });
}

export async function listLinks(ctx: TenantContext, appId: string, environmentId: string): Promise<(LinkRow & { clicks: number; clicks_7d: number; installs: number })[]> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const rows = await db.query<LinkRow & { clicks: string; clicks_7d: string; installs: string }>(
      `select ${LINK_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ")},
              (select count(*) from platform.attribution_touchpoints t where t.link_id = l.id and t.kind = 'click') as clicks,
              (select count(*) from platform.attribution_touchpoints t where t.link_id = l.id and t.kind = 'click' and t.touchpoint_at > now() - interval '7 days') as clicks_7d,
              (select count(*) from platform.attribution_events ae where ae.link_id = l.id and ae.kind in ('install', 'reinstall')) as installs
         from platform.attribution_links l
        where l.app_id = $1 and l.environment_id = $2
        order by l.created_at desc limit 500`,
      [appId, environmentId],
    );
    return rows.map((r) => ({ ...r, clicks: Number(r.clicks), clicks_7d: Number(r.clicks_7d), installs: Number(r.installs) }));
  });
}

// ── Clicks (public redirect) ────────────────────────────────────────────────
export const CLICKS_PER_IP_PER_MINUTE = Number(process.env.LINK_CLICKS_PER_IP_PER_MINUTE ?? 20);
export const CLICKS_PER_ENVIRONMENT_PER_MINUTE = Number(process.env.LINK_CLICKS_PER_ENV_PER_MINUTE ?? 6000);

export interface ClickRequest {
  method: string;
  headers: Headers;
  ip: string | null;
  query: URLSearchParams;
}

export type ClickOutcome =
  | { status: 404 }
  | { status: 302; location: string; recorded: false; reason: "bot" | "prefetch" | "head" | "paused" | "rate_limited" }
  | { status: 302; location: string; recorded: true; clickId: string };

/**
 * Handles GET /l/{code}: picks the destination for the visitor's platform and
 * records a click touchpoint. Crawlers, link unfurlers, prefetches, HEAD
 * requests, paused links and rate-limited senders are redirected without
 * being recorded: the visitor always reaches the store. The raw IP is only
 * used for a keyed hash; coarse country comes from the edge when present.
 */
export async function handleClick(code: string, req: ClickRequest): Promise<ClickOutcome> {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(code)) return { status: 404 };
  const link = await withSystem((db) =>
    db.one<LinkRow & { organization_id: string; app_id: string }>(
      `select organization_id, app_id, ${LINK_COLUMNS} from platform.attribution_links where code = $1`,
      [code],
    ),
  );
  if (!link) return { status: 404 };
  const ua = req.headers.get("user-agent");
  const { os, major } = parseUserAgent(ua);
  // Ad networks substitute campaign macros into the link: these override the link's own labels.
  const q = (k: string) => req.query.get(k)?.trim().slice(0, 100) || null;
  const labels: LinkDestinations = {
    ...link,
    campaign: q("utm_campaign") ?? q("campaign") ?? link.campaign,
    ad_group: q("utm_term") ?? q("ad_group") ?? link.ad_group,
    creative: q("utm_content") ?? q("creative") ?? link.creative,
  };
  const passthrough = (reason: "bot" | "prefetch" | "head" | "paused" | "rate_limited") => ({ status: 302 as const, location: destinationFor(labels, os, null), recorded: false as const, reason });

  if (req.method === "HEAD") return passthrough("head");
  if (isPrefetch(req.headers)) return passthrough("prefetch");
  if (isBot(ua)) return passthrough("bot");
  if (link.status !== "active") return passthrough("paused");

  const ipHash = hashIp(link.app_id, req.ip);
  if (await consumeRateLimit(`click:${link.environment_id}`, CLICKS_PER_ENVIRONMENT_PER_MINUTE, 60)) return passthrough("rate_limited");
  if (await consumeRateLimit(`click:${link.id}:${ipHash ?? req.ip ?? "unknown"}`, CLICKS_PER_IP_PER_MINUTE, 60)) return passthrough("rate_limited");

  let network: { param: string; value: string; network: string } | null = null;
  for (const [param, net] of Object.entries(NETWORK_CLICK_IDS)) {
    const v = req.query.get(param)?.trim();
    if (v) {
      network = { param: param === "sccid" ? "ScCid" : param, value: v.slice(0, 500), network: net };
      break;
    }
  }
  const country = req.headers.get("x-vercel-ip-country")?.trim().toUpperCase();
  let referrerHost: string | null = null;
  try {
    const r = req.headers.get("referer");
    referrerHost = r ? new URL(r).hostname.slice(0, 200) : null;
  } catch {
    referrerHost = null;
  }
  const clickId = `lac_${randomToken(16)}`;
  await withSystem((db) =>
    db.query(
      `insert into platform.attribution_touchpoints
         (organization_id, app_id, environment_id, provider, kind, link_id, source, medium, campaign, ad_group, creative, click_id,
          network_click_id, network, referrer, touchpoint_at, ip_hash, user_agent, os_name, os_major, country, raw)
       values ($1, $2, $3, 'link', 'click', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14, $15, $16, $17, $18, $19)`,
      [link.organization_id, link.app_id, link.environment_id, link.id, link.source, link.medium, labels.campaign, labels.ad_group, labels.creative,
       clickId, network?.value ?? null, network?.network ?? null, referrerHost, ipHash, ua?.slice(0, 512) ?? null, os, major,
       country && /^[A-Z]{2}$/.test(country) ? country : null, JSON.stringify(network ? { network_click_param: network.param } : {})],
    ),
  );
  return { status: 302, location: destinationFor(labels, os, clickId), recorded: true, clickId };
}

// ── Postback configuration ──────────────────────────────────────────────────
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const list = (max: number) =>
  z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    [...new Set((Array.isArray(v) ? v : (v ?? "").split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))].slice(0, max),
  );

const postbackSchema = z.object({
  environmentId: z.string().uuid("Choose an environment."),
  network: z.enum(NETWORKS, "Choose a network."),
  name: z.string().trim().min(1, "Name the postback.").max(120),
  events: list(50).refine((v) => v.length > 0, "List at least one event (install, re_engagement, or a conversion event name).")
    .refine((v) => v.every((e) => EVENT_NAME.test(e)), "Event names are lowercase snake_case (e.g. install, purchase_completed)."),
  sources: list(20).transform((v) => v.map((s) => s.toLowerCase().slice(0, 100))),
  includeOrganic: formBool,
  urlTemplate: z.string().trim().max(2000).optional().transform((v) => v || null),
  httpMethod: z.enum(["GET", "POST"]).default("GET"),
  config: z.record(z.string(), z.string().trim().max(500)).default({}),
  credentials: z.record(z.string(), z.string().trim().max(4000)).default({}),
});

export interface PostbackRow {
  id: string;
  environment_id: string;
  network: Network;
  name: string;
  events: string[];
  sources: string[];
  include_organic: boolean;
  url_template: string | null;
  http_method: "GET" | "POST";
  config: Record<string, string>;
  has_credentials: boolean;
  status: "active" | "paused";
  created_at: Date;
}

const POSTBACK_COLUMNS = "id, environment_id, network, name, events, sources, include_organic, url_template, http_method, config, has_credentials, status, created_at";

export async function createPostback(ctx: TenantContext, appId: string, input: unknown): Promise<PostbackRow> {
  const r = postbackSchema.safeParse(input);
  if (!r.success) throw issue(r.error);
  const p = r.data;
  const spec = NETWORK_SPECS[p.network];
  const config: Record<string, string> = {};
  for (const f of spec.config) {
    const v = p.config[f.key]?.trim();
    if (v) config[f.key] = v;
    else if (f.required) throw new ValidationError(`${f.label} is required for ${spec.label}.`);
  }
  const credentials: Record<string, string> = {};
  for (const f of spec.credentials) {
    const v = p.credentials[f.key]?.trim();
    if (v) credentials[f.key] = v;
    else if (f.required) throw new ValidationError(`${f.label} is required for ${spec.label}.`);
  }
  if (p.network === "custom") {
    if (!p.urlTemplate) throw new ValidationError("Enter the postback URL template.");
    const unknown = unknownMacros(p.urlTemplate);
    if (unknown.length) throw new ValidationError(`Unknown macro: {${unknown[0]}}.`);
    assertPostbackUrlShape(p.urlTemplate.replace(/\{[a-z_]+\}/g, "x"));
  } else if (p.includeOrganic) {
    throw new ValidationError("Ad networks only receive installs they drove; organic events can go to a custom postback.");
  }
  if (Object.keys(credentials).length && !encryptionAvailable()) {
    throw new ValidationError("Credentials can't be stored: the server has no INTEGRATIONS_ENCRYPTION_KEY configured. Ask your LeanApp administrator.");
  }
  const enc = Object.keys(credentials).length ? encryptSecret(JSON.stringify(credentials)) : null;
  return tenantTx(ctx, "attribution.manage", async (db) => {
    await assertEnvironment(db, appId, p.environmentId);
    const row = await db.one<PostbackRow>(
      `insert into platform.attribution_postbacks (organization_id, app_id, environment_id, network, name, events, sources, include_organic,
                                                   url_template, http_method, config, credentials_enc, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning ${POSTBACK_COLUMNS}`,
      [ctx.organizationId, appId, p.environmentId, p.network, p.name, p.events, p.sources, p.network === "custom" && p.includeOrganic,
       p.network === "custom" ? p.urlTemplate : null, p.network === "custom" ? p.httpMethod : "POST", JSON.stringify(config), enc, ctx.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.postback_created", targetType: "attribution_postback", targetId: row!.id,
      metadata: { network: p.network, environment_id: p.environmentId, events: p.events, credentials: Object.keys(credentials) },
    });
    return row!;
  });
}

export async function setPostbackStatus(ctx: TenantContext, appId: string, id: string, status: "active" | "paused" | "deleted"): Promise<void> {
  if (!z.string().uuid().safeParse(id).success || !["active", "paused", "deleted"].includes(status)) throw new ValidationError("Invalid postback.");
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = status === "deleted"
      ? await db.one("delete from platform.attribution_postbacks where id = $1 and app_id = $2 returning id", [id, appId])
      : await db.one("update platform.attribution_postbacks set status = $3 where id = $1 and app_id = $2 returning id", [id, appId, status]);
    if (!row) throw new NotFoundError("Postback");
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: status === "deleted" ? "attribution.postback_deleted" : "attribution.postback_updated",
      targetType: "attribution_postback", targetId: id, metadata: { status },
    });
  });
}

export interface DeliveryRow {
  id: string;
  postback_id: string;
  postback_name: string;
  event_name: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: Date;
  delivered_at: Date | null;
  created_at: Date;
}

export async function listPostbacks(ctx: TenantContext, appId: string, environmentId: string): Promise<{ postbacks: (PostbackRow & { pending: number; succeeded: number; failed: number })[]; deliveries: DeliveryRow[] }> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const postbacks = await db.query<PostbackRow & { pending: string; succeeded: string; failed: string }>(
      `select ${POSTBACK_COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")},
              count(d.id) filter (where d.status = 'pending') as pending,
              count(d.id) filter (where d.status = 'succeeded') as succeeded,
              count(d.id) filter (where d.status in ('failed', 'giving_up')) as failed
         from platform.attribution_postbacks p
         left join platform.attribution_postback_deliveries d on d.postback_id = p.id
        where p.app_id = $1 and p.environment_id = $2
        group by p.id order by p.created_at desc`,
      [appId, environmentId],
    );
    const deliveries = await db.query<DeliveryRow>(
      `select d.id, d.postback_id, p.name as postback_name, d.event_name, d.status, d.attempts, d.last_status_code, d.last_error,
              d.next_attempt_at, d.delivered_at, d.created_at
         from platform.attribution_postback_deliveries d
         join platform.attribution_postbacks p on p.id = d.postback_id
        where p.app_id = $1 and d.environment_id = $2
        order by d.created_at desc limit 50`,
      [appId, environmentId],
    );
    return { postbacks: postbacks.map((p) => ({ ...p, pending: Number(p.pending), succeeded: Number(p.succeeded), failed: Number(p.failed) })), deliveries };
  });
}
