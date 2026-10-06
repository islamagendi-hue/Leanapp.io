import "server-only";
import { z } from "zod";
import { isUniqueViolation, withSystem, type Db } from "@/lib/db";
import { envNumber } from "@/lib/env-number";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { consumeRateLimit } from "@/lib/rate-limit";
import { audit } from "@/modules/audit/service";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { AAK_PRODUCTION_KID, networkOfSkanId, parseAakPostback, parseSkanPostback, SKAN_ID, type SkanRecord } from "./skan";
import { parseConversionSchema, type ConversionSchema } from "./skan-schema";

/**
 * SKAdNetwork / AdAttributionKit developer postbacks and conversion value
 * schemas (docs/attribution.md#skadnetwork--adattributionkit).
 *
 * Apple sends every app's postback copies to the same well-known URL, so a
 * postback is routed by its App Store id (attribution_settings.ios_app_store_id,
 * unique across LeanApp) after its signature is verified. SKAdNetwork
 * postbacks and AdAttributionKit production postbacks go to the app's
 * production environment; AdAttributionKit development-key postbacks go to
 * development. Duplicates (same transaction / postback id) are discarded.
 */

export const SKAN_POSTBACKS_PER_IP_PER_MINUTE = envNumber("SKAN_POSTBACKS_PER_IP_PER_MINUTE", 120);
export const SKAN_POSTBACKS_PER_APP_PER_MINUTE = envNumber("SKAN_POSTBACKS_PER_APP_PER_MINUTE", 6000);
const MAX_BODY = 16 * 1024;

export interface PostbackResult {
  status: number;
  body: Record<string, unknown>;
  retryAfter?: number;
}

/** Handles POST /.well-known/skadnetwork/report-attribution/ and /.well-known/appattribution/report-attribution/. */
export async function handleSkanPostback(
  framework: "skadnetwork" | "adattributionkit",
  bodyText: string,
  ip: string | null,
  opts: { skanKey?: string; aakKeys?: Record<string, string> } = {},
): Promise<PostbackResult> {
  const ipWait = await consumeRateLimit(`skan-ip:${ip ?? "unknown"}`, SKAN_POSTBACKS_PER_IP_PER_MINUTE, 60);
  if (ipWait) return { status: 429, body: { error: "rate_limited" }, retryAfter: ipWait };
  if (bodyText.length > MAX_BODY) return { status: 413, body: { error: "payload_too_large" } };
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "invalid_postback" } };
  const parsed = framework === "skadnetwork" ? parseSkanPostback(body as Record<string, unknown>, opts.skanKey) : parseAakPostback(body as Record<string, unknown>, opts.aakKeys);
  // Postbacks that fail verification are not Apple's: refused and never counted.
  if (!parsed.ok) return { status: 400, body: { error: "invalid_signature", message: parsed.reason } };
  const r = parsed.record;
  const envType = r.framework === "adattributionkit" && r.keyId !== AAK_PRODUCTION_KID ? "development" : "production";
  try {
    const target = await withSystem((db) =>
      db.one<{ organization_id: string; app_id: string; environment_id: string }>(
        `select s.organization_id, s.app_id, e.id as environment_id
           from platform.attribution_settings s
           join platform.apps a on a.id = s.app_id and a.status = 'active'
           join platform.environments e on e.app_id = s.app_id and e.type = $2 and e.status = 'active'
          where s.ios_app_store_id = $1`,
        [r.appStoreId, envType],
      ),
    );
    // Unclaimed App Store id: 404, so the device retries (up to 9 days) while the customer finishes setup.
    if (!target) return { status: 404, body: { error: "unknown_app", message: "No LeanApp app has this App Store id." } };
    const wait = await consumeRateLimit(`skan:${target.app_id}`, SKAN_POSTBACKS_PER_APP_PER_MINUTE, 60);
    if (wait) return { status: 429, body: { error: "rate_limited" }, retryAfter: wait };
    const stored = await withSystem((db) => insertPostback(db, target, r, body as Record<string, unknown>));
    return { status: 200, body: { ok: true, duplicate: !stored } };
  } catch (err) {
    log.error("attribution.skan_postback_failed", { error: err, framework });
    return { status: 500, body: { error: "internal_error" } };
  }
}

async function insertPostback(db: Db, t: { organization_id: string; app_id: string; environment_id: string }, r: SkanRecord, payload: Record<string, unknown>): Promise<boolean> {
  const row = await db.one(
    `insert into platform.skan_postbacks (organization_id, app_id, environment_id, framework, version, key_id, transaction_id, ad_network_id, source_identifier,
       app_store_id, source_app_id, source_domain, redownload, conversion_type, fidelity_type, ad_interaction_type, did_win, postback_sequence_index,
       fine_value, coarse_value, country_code, marketplace_id, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     on conflict (environment_id, framework, transaction_id) do nothing returning id`,
    [t.organization_id, t.app_id, t.environment_id, r.framework, r.version, r.keyId, r.transactionId, r.adNetworkId, r.sourceIdentifier, r.appStoreId,
     r.sourceAppId, r.sourceDomain, r.redownload, r.conversionType, r.fidelityType, r.adInteractionType, r.didWin, r.sequenceIndex, r.fineValue,
     r.coarseValue, r.countryCode, r.marketplaceId, JSON.stringify(payload)],
  );
  return Boolean(row);
}

// ── Settings: App Store id and the SKAdNetwork ids in Info.plist ────────────
export interface SkanSettings {
  ios_app_store_id: string | null;
  skan_network_ids: string[];
}

export async function getSkanSettings(ctx: TenantContext, appId: string): Promise<SkanSettings> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const row = await db.one<SkanSettings>("select ios_app_store_id::text, skan_network_ids from platform.attribution_settings where app_id = $1", [appId]);
    return row ?? { ios_app_store_id: null, skan_network_ids: [] };
  });
}

const settingsSchema = z.object({
  appStoreId: z.string().trim().optional().transform((v) => (v ? v.replace(/^id/i, "") : null))
    .refine((v) => v === null || /^[1-9]\d{3,14}$/.test(v), "The App Store id is the number in your App Store URL (apps.apple.com/app/id123456789)."),
  networkIds: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    [...new Set((Array.isArray(v) ? v : (v ?? "").split(/[\s,<>]+/)).map((x) => x.trim().toLowerCase()).filter((x) => x.endsWith(".skadnetwork")))].slice(0, 500),
  ).refine((ids) => ids.every((id) => SKAN_ID.test(id)), "SKAdNetwork ids look like abcd1234.skadnetwork."),
});

export async function updateSkanSettings(ctx: TenantContext, appId: string, input: unknown): Promise<void> {
  const r = settingsSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  const s = r.data;
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const app = await db.one("select 1 from platform.apps where id = $1", [appId]);
    if (!app) throw new NotFoundError("App");
    try {
      await db.query("savepoint skan_settings");
      await db.query(
        `insert into platform.attribution_settings (organization_id, app_id, ios_app_store_id, skan_network_ids, updated_at) values ($1, $2, $3, $4, now())
         on conflict (app_id) do update set ios_app_store_id = excluded.ios_app_store_id, skan_network_ids = excluded.skan_network_ids, updated_at = now()`,
        [ctx.organizationId, appId, s.appStoreId, s.networkIds],
      );
    } catch (err) {
      await db.query("rollback to savepoint skan_settings");
      if (isUniqueViolation(err)) throw new ValidationError("This App Store id is already connected to another LeanApp app. If the app is yours, contact LeanApp support.");
      throw err;
    }
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.skan_settings_updated", targetType: "app", targetId: appId,
      metadata: { ios_app_store_id: s.appStoreId, skan_network_ids: s.networkIds.length },
    });
  });
}

// ── Conversion value schema ─────────────────────────────────────────────────
export interface StoredSchema {
  schema: ConversionSchema;
  revision: number;
  updated_at: Date;
}

export async function getConversionSchema(ctx: TenantContext, appId: string): Promise<StoredSchema | null> {
  return tenantTx(ctx, "attribution.read", (db) =>
    db.one<StoredSchema>("select schema, revision, updated_at from platform.skan_conversion_schemas where app_id = $1", [appId]),
  );
}

export async function saveConversionSchema(ctx: TenantContext, appId: string, input: unknown): Promise<StoredSchema> {
  const parsed = parseConversionSchema(input);
  if (!parsed.ok) throw new ValidationError(parsed.message);
  return tenantTx(ctx, "attribution.manage", async (db) => {
    const app = await db.one("select 1 from platform.apps where id = $1", [appId]);
    if (!app) throw new NotFoundError("App");
    const row = await db.one<StoredSchema>(
      `insert into platform.skan_conversion_schemas (organization_id, app_id, schema, updated_by) values ($1, $2, $3, $4)
       on conflict (app_id) do update set schema = excluded.schema, revision = platform.skan_conversion_schemas.revision + 1,
         updated_by = excluded.updated_by, updated_at = now()
       returning schema, revision, updated_at`,
      [ctx.organizationId, appId, JSON.stringify(parsed.schema), ctx.userId],
    );
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.skan_schema_updated", targetType: "app", targetId: appId,
      metadata: { revision: row!.revision, rules: parsed.schema.rules.length },
    });
    return row!;
  });
}

export async function deleteConversionSchema(ctx: TenantContext, appId: string): Promise<void> {
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = await db.one("delete from platform.skan_conversion_schemas where app_id = $1 returning app_id", [appId]);
    if (!row) throw new NotFoundError("Schema");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.skan_schema_updated", targetType: "app", targetId: appId, metadata: { deleted: true } });
  });
}

export const SCHEMA_FETCHES_PER_MINUTE = envNumber("SKAN_SCHEMA_FETCHES_PER_MINUTE", 6000);

/** GET /v1/skan/conversion-schema for the iOS SDK (public SDK key or secret key of the app). */
export async function schemaForKey(key: IngestionPrincipal): Promise<{ schema: ConversionSchema | null; revision: number | null; updated_at: string | null }> {
  const row = await withSystem((db) =>
    db.one<StoredSchema>("select schema, revision, updated_at from platform.skan_conversion_schemas where app_id = $1 and organization_id = $2", [key.appId, key.organizationId]),
  );
  return { schema: row?.schema ?? null, revision: row?.revision ?? null, updated_at: row ? new Date(row.updated_at).toISOString() : null };
}

// ── Reports ─────────────────────────────────────────────────────────────────
export interface SkanSourceRow {
  framework: string;
  ad_network_id: string;
  network: string | null;
  source_identifier: string | null;
  postbacks: number;
  wins: number;
  first: number;
  second: number;
  third: number;
  redownloads: number;
  fine_avg: number | null;
  coarse_low: number;
  coarse_medium: number;
  coarse_high: number;
  last_at: Date;
}

/** Postbacks per ad network and source identifier (campaign) for one environment over `days` days. */
export async function skanBySource(ctx: TenantContext, environmentId: string, days: number): Promise<SkanSourceRow[]> {
  return tenantTx(ctx, "attribution.read", async (db) => {
    const rows = await db.query<Record<string, string | null> & { last_at: Date }>(
      `select framework, ad_network_id, source_identifier, count(*) as postbacks,
              count(*) filter (where did_win) as wins,
              count(*) filter (where postback_sequence_index = 0) as first,
              count(*) filter (where postback_sequence_index = 1) as second,
              count(*) filter (where postback_sequence_index = 2) as third,
              count(*) filter (where redownload) as redownloads,
              avg(fine_value) as fine_avg,
              count(*) filter (where coarse_value = 'low') as coarse_low,
              count(*) filter (where coarse_value = 'medium') as coarse_medium,
              count(*) filter (where coarse_value = 'high') as coarse_high,
              max(received_at) as last_at
         from platform.skan_postbacks
        where environment_id = $1 and received_at >= now() - make_interval(days => $2)
        group by 1, 2, 3 order by 4 desc limit 200`,
      [environmentId, days],
    );
    const n = (v: string | null) => Number(v ?? 0);
    return rows.map((r) => ({
      framework: r.framework!, ad_network_id: r.ad_network_id!, network: networkOfSkanId(r.ad_network_id!), source_identifier: r.source_identifier,
      postbacks: n(r.postbacks), wins: n(r.wins), first: n(r.first), second: n(r.second), third: n(r.third), redownloads: n(r.redownloads),
      fine_avg: r.fine_avg === null ? null : Number(r.fine_avg), coarse_low: n(r.coarse_low), coarse_medium: n(r.coarse_medium), coarse_high: n(r.coarse_high),
      last_at: r.last_at,
    }));
  });
}

/**
 * Where Apple sends postback copies for an app that puts `plistValue` in
 * NSAdvertisingAttributionReportEndpoint / AttributionCopyEndpoint. Apple uses
 * only the registrable domain (subdomains are ignored), so the root of that
 * domain must route /.well-known/skadnetwork/… and /.well-known/appattribution/…
 * to this deployment. SKAN_REPORT_DOMAIN names that domain; without it the
 * public API host's last two labels are assumed and the page says so.
 */
export function skanEndpoint(apiBaseUrl: string, env: Record<string, string | undefined> = process.env) {
  const configured = env.SKAN_REPORT_DOMAIN?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
  let host = "localhost";
  try {
    host = new URL(apiBaseUrl).hostname;
  } catch {
    // keep localhost
  }
  const domain = configured ?? host.split(".").slice(-2).join(".");
  return {
    domain,
    configured: Boolean(configured),
    plistValue: `https://${domain}`,
    skadnetworkUrl: `https://${domain}/.well-known/skadnetwork/report-attribution/`,
    adattributionkitUrl: `https://${domain}/.well-known/appattribution/report-attribution/`,
  };
}
