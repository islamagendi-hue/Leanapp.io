import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { encryptionAvailable } from "@/lib/secret-box";
import { msg } from "@/i18n/translate";
import { localDate } from "@/modules/analytics/range";
import { adServicesStats } from "@/modules/attribution/adservices";
import { audit } from "@/modules/audit/service";
import { can } from "@/modules/rbac/authorize";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { AD_ADAPTERS } from "./ads";
import { ProviderError, type HttpOptions } from "./ads/http";
import type { AdAccount } from "./ads/types";
import { exchangeCode, OAUTH_STATE_TTL_SECONDS, oauthConfigured } from "./oauth";
import { CONVERSION_NETWORK, isAdProvider, type AdProvider } from "./registry";
import { addDays, MAX_BACKFILL_DAYS } from "./status";
import { credentialAad, persistSecrets, readSecrets, rebuildSpend, refreshCapabilityStatus, removeImportedSpend, syncConnection, type SyncResult } from "./sync";

/**
 * Integrations Center service (tenant scope). Connections are per
 * environment and provider; each carries capabilities with their own status.
 * Reading needs integrations.read; changing needs integrations.manage.
 * Secrets are encrypted (lib/secret-box, bound to the connection row) and are
 * read back only in system scope, filtered by the caller's organization.
 */

export const AD_CAPABILITIES = ["ad_reporting", "spend_import"] as const;
export type AdCapability = (typeof AD_CAPABILITIES)[number];

export interface CapabilityView {
  id: string;
  capability: string;
  enabled: boolean;
  config: Record<string, string>;
  status: "not_configured" | "credentials_missing" | "unverified" | "verified" | "error";
  status_detail: string | null;
  verified_at: Date | null;
  last_sync_started_at: Date | null;
  last_success_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
  data_fresh_through: string | null;
  next_sync_at: Date | null;
  backfill_from: string | null;
  backfill_cursor: string | null;
}

export interface ConnectionView {
  id: string;
  environment_id: string;
  provider: string;
  auth_method: "manual" | "oauth";
  config: Record<string, string>;
  has_credentials: boolean;
  credentials_updated_at: Date | null;
  token_expires_at: Date | null;
  granted_scopes: string[];
  missing_fields: string[];
  status: "active" | "disabled";
  capabilities: CapabilityView[];
}

async function assertEnvironment(db: Db, appId: string, environmentId: string) {
  if (!z.uuid().safeParse(environmentId).success) throw new NotFoundError("Environment");
  const env = await db.one("select 1 from platform.environments where id = $1 and app_id = $2", [environmentId, appId]);
  if (!env) throw new NotFoundError("Environment");
}

const CONN_COLUMNS = "id, environment_id, provider, auth_method, config, has_credentials, credentials_updated_at, token_expires_at, granted_scopes, missing_fields, status";
const CAP_COLUMNS = `id, connection_id, capability, enabled, config, status, status_detail, verified_at, last_sync_started_at, last_success_at, last_error_at, last_error,
  data_fresh_through::text as data_fresh_through, next_sync_at, backfill_from::text as backfill_from, backfill_cursor::text as backfill_cursor`;

export async function listConnections(ctx: TenantContext, appId: string, environmentId: string): Promise<ConnectionView[]> {
  return tenantTx(ctx, "integrations.read", async (db) => {
    await assertEnvironment(db, appId, environmentId);
    const conns = await db.query<Omit<ConnectionView, "capabilities">>(`select ${CONN_COLUMNS} from platform.integration_connections where environment_id = $1 order by provider`, [environmentId]);
    const caps = await db.query<CapabilityView & { connection_id: string }>(
      `select ${CAP_COLUMNS} from platform.integration_capabilities where connection_id = any($1) order by capability`,
      [conns.map((c) => c.id)],
    );
    return conns.map((c) => ({ ...c, capabilities: caps.filter((k) => k.connection_id === c.id) }));
  });
}

async function connectionOf(db: Db, appId: string, connectionId: string) {
  if (!z.uuid().safeParse(connectionId).success) throw new NotFoundError("Connection");
  const row = await db.one<{ id: string; environment_id: string; provider: string }>(
    "select id, environment_id, provider from platform.integration_connections where id = $1 and app_id = $2",
    [connectionId, appId],
  );
  if (!row) throw new NotFoundError("Connection");
  return row;
}

// ── Saving credentials and settings ─────────────────────────────────────────
const fieldsSchema = z.record(z.string().max(60), z.string().max(4000)).default({});

/** Secrets the browser sent; a blank field keeps the stored value. */
function mergeSecrets(stored: Record<string, string>, given: Record<string, string>, allowed: string[]) {
  const out = { ...stored };
  for (const k of allowed) {
    const v = given[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

async function storedSecrets(ctx: TenantContext, connectionId: string | null): Promise<Record<string, string>> {
  if (!connectionId) return {};
  return withSystem(async (db) => {
    const row = await db.one<{ id: string; credentials_enc: string | null }>(
      "select id, credentials_enc from platform.integration_connections where id = $1 and organization_id = $2",
      [connectionId, ctx.organizationId],
    );
    return row ? readSecrets(row) : {};
  });
}

/**
 * Creates or updates the environment's connection to an ad provider:
 * credentials (merged with stored ones, blank keeps), settings, and the
 * ad_reporting / spend_import capability rows. Turning a capability on is a
 * separate step (setCapability), so saving credentials never starts imports.
 */
export async function saveAdConnection(
  ctx: TenantContext,
  appId: string,
  input: { environmentId: string; provider: string; secrets?: unknown; settings?: unknown },
  extra: { authMethod?: "manual" | "oauth"; oauthSecrets?: Record<string, string>; scopes?: string[]; expiresAt?: Date | null } = {},
): Promise<{ id: string; missing: string[] }> {
  if (!isAdProvider(input.provider)) throw new ValidationError(msg("Unknown provider."));
  const provider = input.provider;
  const adapter = AD_ADAPTERS[provider];
  const secretsIn = fieldsSchema.parse(input.secrets ?? {});
  const settingsIn = fieldsSchema.parse(input.settings ?? {});
  if (!encryptionAvailable()) throw new ValidationError(msg("Credentials can't be stored: the server has no INTEGRATIONS_ENCRYPTION_KEY configured. Ask your LeanApp administrator."));

  const settings: Record<string, string> = {};
  for (const f of adapter.settings) {
    const v = settingsIn[f.key]?.trim().slice(0, 500);
    if (!v) continue;
    if (f.pattern && !f.pattern.test(v)) throw new ValidationError(`${f.label}: ${msg("check the format.")}`, { [`settings.${f.key}`]: f.label });
    settings[f.key] = v;
  }

  const existing = await tenantTx(ctx, "integrations.manage", async (db) => {
    await assertEnvironment(db, appId, input.environmentId);
    return db.one<{ id: string; config: Record<string, string> }>("select id, config from platform.integration_connections where environment_id = $1 and provider = $2", [input.environmentId, provider]);
  });
  const stored = await storedSecrets(ctx, existing?.id ?? null);
  const manualSecretsGiven = Object.values(secretsIn).some((v) => v.trim());
  // Pasting credentials over an OAuth connection replaces them entirely (they no longer use LeanApp's app).
  const secrets = extra.oauthSecrets ?? mergeSecrets(stored.oauth_app === "leanapp" && manualSecretsGiven ? {} : stored, secretsIn, adapter.secrets.map((s) => s.key));
  const mergedSettings = { ...(existing?.config ?? {}), ...settings };
  for (const f of adapter.settings) if (settingsIn[f.key] !== undefined && !settingsIn[f.key].trim()) delete mergedSettings[f.key];
  const missing = adapter.missing(secrets, mergedSettings);
  const id = existing?.id ?? randomUUID();
  const authMethod = extra.authMethod ?? (manualSecretsGiven || !existing ? "manual" : null);
  const hasSecrets = Object.keys(secrets).length > 0;

  await tenantTx(ctx, "integrations.manage", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [input.environmentId]);
    if (!existing) {
      await db.query(
        `insert into platform.integration_connections (id, organization_id, app_id, environment_id, provider, auth_method, config, missing_fields, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.organizationId, env!.app_id, input.environmentId, provider, authMethod ?? "manual", JSON.stringify(mergedSettings), missing, ctx.userId],
      );
    } else {
      await db.query(
        `update platform.integration_connections set config = $2, missing_fields = $3, auth_method = coalesce($4, auth_method),
                granted_scopes = coalesce($5, granted_scopes) where id = $1`,
        [id, JSON.stringify(mergedSettings), missing, authMethod, extra.scopes ?? null],
      );
    }
    if (hasSecrets && (extra.oauthSecrets || manualSecretsGiven)) {
      await persistSecrets(db, id, secrets, extra.expiresAt);
      // New credentials: errors from the old ones no longer apply, and an auth-stopped sync may resume.
      await db.query(
        `update platform.integration_capabilities set last_error = null, last_error_at = null, error_count = 0, verified_at = null,
                next_sync_at = case when enabled then now() else next_sync_at end where connection_id = $1`,
        [id],
      );
    }
    if (extra.scopes && !existing) await db.query("update platform.integration_connections set granted_scopes = $2 where id = $1", [id, extra.scopes]);
    for (const cap of AD_CAPABILITIES) {
      await db.query(
        "insert into platform.integration_capabilities (organization_id, connection_id, capability) values ($1, $2, $3) on conflict (connection_id, capability) do nothing",
        [ctx.organizationId, id, cap],
      );
    }
    await refreshCapabilityStatus(db, id);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.connection_saved", targetType: "integration_connection", targetId: id,
      metadata: { provider, environment_id: input.environmentId, settings: mergedSettings, secrets_changed: Object.keys(secretsIn).filter((k) => secretsIn[k].trim()), auth_method: authMethod ?? "unchanged" },
    });
  });
  return { id, missing };
}

const capabilitySchema = z.object({
  enabled: z.boolean(),
  spendSource: z.string().trim().max(100).regex(/^[a-z0-9][a-z0-9_.-]*$/i, msg("Use letters, digits, dots, dashes or underscores.")).optional(),
});

/** Turns ad_reporting or spend_import on or off. Cost import needs reporting on. */
export async function setCapability(ctx: TenantContext, appId: string, connectionId: string, capability: string, input: unknown): Promise<void> {
  if (!(AD_CAPABILITIES as readonly string[]).includes(capability)) throw new ValidationError(msg("Unknown capability."));
  const r = capabilitySchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid input."));
  const { enabled, spendSource } = r.data;
  let rebuild: { id: string; source: string } | null = null;
  await tenantTx(ctx, "integrations.manage", async (db) => {
    const conn = await connectionOf(db, appId, connectionId);
    const caps = await db.query<{ capability: string; enabled: boolean }>("select capability, enabled from platform.integration_capabilities where connection_id = $1", [connectionId]);
    if (capability === "spend_import" && enabled && !caps.find((c) => c.capability === "ad_reporting")?.enabled) {
      throw new ValidationError(msg("Turn on ad reporting import first: cost import uses its data."));
    }
    const config = capability === "spend_import" ? { spend_source: (spendSource || AD_ADAPTERS[conn.provider as AdProvider].defaultSpendSource).toLowerCase() } : {};
    await db.query(
      `update platform.integration_capabilities set enabled = $3, config = case when $4::jsonb = '{}'::jsonb then config else $4::jsonb end,
              next_sync_at = case when $3 and capability = 'ad_reporting' then coalesce(next_sync_at, now()) when not $3 then null else next_sync_at end
        where connection_id = $1 and capability = $2`,
      [connectionId, capability, enabled, JSON.stringify(config)],
    );
    if (capability === "ad_reporting" && !enabled) {
      await db.query("update platform.integration_capabilities set enabled = false where connection_id = $1 and capability = 'spend_import'", [connectionId]);
    }
    if ((capability === "spend_import" && !enabled) || (capability === "ad_reporting" && !enabled)) await removeImportedSpend(db, connectionId, conn.environment_id);
    if (capability === "spend_import" && enabled) rebuild = { id: connectionId, source: config.spend_source! };
    await refreshCapabilityStatus(db, connectionId);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.capability_updated", targetType: "integration_connection", targetId: connectionId,
      metadata: { capability, enabled, ...config },
    });
  });
  if (rebuild) {
    const { id, source } = rebuild;
    await rebuildSpend(id, source);
  }
}

/** Asks for history: the worker imports backwards from today in 30-day chunks down to `from`. */
export async function requestBackfill(ctx: TenantContext, appId: string, connectionId: string, from: string, timezone: string): Promise<void> {
  const today = localDate(new Date(), timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) throw new ValidationError(msg("Enter the date as YYYY-MM-DD."));
  if (from >= today) throw new ValidationError(msg("Choose a day in the past."));
  if (from < addDays(today, -MAX_BACKFILL_DAYS)) throw new ValidationError(msg("History can be imported for up to 395 days."));
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await connectionOf(db, appId, connectionId);
    const row = await db.one(
      `update platform.integration_capabilities set backfill_from = $2::date, backfill_cursor = null, next_sync_at = now()
        where connection_id = $1 and capability = 'ad_reporting' and enabled returning id`,
      [connectionId, from],
    );
    if (!row) throw new ValidationError(msg("Turn on ad reporting import first."));
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.backfill_requested", targetType: "integration_connection", targetId: connectionId, metadata: { from } });
  });
}

/** Runs a sync now (same engine as the worker). */
export async function syncNow(ctx: TenantContext, appId: string, connectionId: string, deps: { http?: HttpOptions } = {}): Promise<SyncResult> {
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await connectionOf(db, appId, connectionId);
    const cap = await db.one("select 1 from platform.integration_capabilities where connection_id = $1 and capability = 'ad_reporting' and enabled", [connectionId]);
    if (!cap) throw new ValidationError(msg("Turn on ad reporting import first."));
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.sync_requested", targetType: "integration_connection", targetId: connectionId });
  });
  return syncConnection(connectionId, { manual: true, deadline: Date.now() + 25_000, http: deps.http });
}

/**
 * Checks the stored credentials against the live provider (token refresh and
 * the ad-account listing). Success marks ad reporting verified; failure is
 * recorded as its last error. Returns the accounts the credentials can read.
 */
export async function verifyConnection(ctx: TenantContext, appId: string, connectionId: string, deps: { http?: HttpOptions } = {}): Promise<{ ok: true; accounts: AdAccount[] } | { ok: false; error: string }> {
  const conn = await tenantTx(ctx, "integrations.manage", async (db) => {
    const c = await connectionOf(db, appId, connectionId);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.verify_requested", targetType: "integration_connection", targetId: connectionId });
    return c;
  });
  const provider = conn.provider as AdProvider;
  const adapter = AD_ADAPTERS[provider];
  const http = { ...deps.http, budget: { remaining: 20, used: 0 }, deadline: Date.now() + 20_000 };
  return withSystem(async (db) => {
    const row = await db.one<{ id: string; credentials_enc: string | null; config: Record<string, string> }>(
      "select id, credentials_enc, config from platform.integration_connections where id = $1 and organization_id = $2",
      [connectionId, ctx.organizationId],
    );
    if (!row?.credentials_enc) return { ok: false as const, error: msg("No credentials stored.") };
    try {
      const session = await adapter.prepare(readSecrets(row), row.config, http);
      if (session.updatedSecrets) await persistSecrets(db, row.id, session.updatedSecrets, session.expiresAt);
      const accounts = await adapter.listAccounts(session, row.config, http);
      await db.query(
        `update platform.integration_capabilities set verified_at = now(), last_error = null, last_error_at = null, error_count = 0 where connection_id = $1 and capability = 'ad_reporting'`,
        [row.id],
      );
      await refreshCapabilityStatus(db, row.id);
      return { ok: true as const, accounts };
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : msg("Stored credentials can't be read (encryption key missing or changed). Enter them again.");
      await db.query(
        "update platform.integration_capabilities set last_error_at = now(), last_error = $2 where connection_id = $1 and capability = 'ad_reporting'",
        [row.id, message.slice(0, 500)],
      );
      await refreshCapabilityStatus(db, row.id);
      return { ok: false as const, error: message };
    }
  });
}

/** Deletes a connection, its capabilities, sync history and imported reporting. Imported Ad spend is removed too; hand-entered spend stays. */
export async function removeConnection(ctx: TenantContext, appId: string, connectionId: string): Promise<void> {
  await tenantTx(ctx, "integrations.manage", async (db) => {
    const conn = await connectionOf(db, appId, connectionId);
    await removeImportedSpend(db, connectionId, conn.environment_id);
    await db.query("delete from platform.integration_connections where id = $1", [connectionId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.connection_removed", targetType: "integration_connection", targetId: connectionId, metadata: { provider: conn.provider } });
  });
}

export interface SyncRunRow {
  id: string;
  kind: string;
  status: string;
  range_from: string | null;
  range_to: string | null;
  rows_imported: number;
  spend_rows: number;
  spend_skipped: number;
  requests: number;
  error_kind: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export async function listSyncRuns(ctx: TenantContext, appId: string, connectionId: string, limit = 20): Promise<SyncRunRow[]> {
  return tenantTx(ctx, "integrations.read", async (db) => {
    await connectionOf(db, appId, connectionId);
    return db.query<SyncRunRow>(
      `select id, kind, status, range_from::text as range_from, range_to::text as range_to, rows_imported, spend_rows, spend_skipped, requests, error_kind, error, started_at, finished_at
         from platform.integration_sync_runs where connection_id = $1 order by started_at desc limit $2`,
      [connectionId, Math.min(Math.max(limit, 1), 100)],
    );
  });
}

export interface CampaignSummary {
  campaign_id: string;
  campaign_name: string | null;
  currency: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number | null;
}

/** Imported totals per campaign over the last `days` days (needs analytics.read as well). */
export async function campaignSummary(ctx: TenantContext, appId: string, connectionId: string, days = 30): Promise<CampaignSummary[]> {
  return tenantTx(ctx, "integrations.read", async (db) => {
    await connectionOf(db, appId, connectionId);
    const rows = await db.query<{ campaign_id: string; campaign_name: string | null; currency: string; impressions: string; clicks: string; spend: string; conversions: string | null }>(
      `select campaign_id, max(campaign_name) as campaign_name, currency, sum(impressions)::text as impressions, sum(clicks)::text as clicks,
              sum(spend)::text as spend, sum(conversions)::text as conversions
         from platform.ad_performance_daily where connection_id = $1 and day >= current_date - $2::int
        group by campaign_id, currency order by sum(spend) desc limit 50`,
      [connectionId, days],
    );
    return rows.map((r) => ({ ...r, impressions: Number(r.impressions), clicks: Number(r.clicks), spend: Number(r.spend), conversions: r.conversions === null ? null : Number(r.conversions) }));
  });
}

// ── OAuth ───────────────────────────────────────────────────────────────────
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** Starts "Connect with …": returns the state (also to be set as a cookie) and stores its hash. */
export async function startOAuth(ctx: TenantContext, appId: string, environmentId: string, provider: string, returnPath: string): Promise<{ state: string }> {
  if (!isAdProvider(provider)) throw new ValidationError(msg("Unknown provider."));
  if (!oauthConfigured(provider)) throw new ValidationError(msg("Connecting with OAuth isn't set up on this server. Enter credentials instead."));
  if (!encryptionAvailable()) throw new ValidationError(msg("Credentials can't be stored: the server has no INTEGRATIONS_ENCRYPTION_KEY configured. Ask your LeanApp administrator."));
  if (!/^\/o\/[a-z0-9-]+\/apps\/[a-z0-9-]+\/[a-z0-9/_-]*$/i.test(returnPath)) throw new ValidationError(msg("Invalid return path."));
  const state = randomBytes(32).toString("base64url");
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await assertEnvironment(db, appId, environmentId);
    await db.query("delete from platform.integration_oauth_states where expires_at < now()");
    await db.query(
      `insert into platform.integration_oauth_states (state_hash, organization_id, app_id, environment_id, user_id, provider, return_path, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
      [sha(state), ctx.organizationId, appId, environmentId, ctx.userId, provider, returnPath, OAUTH_STATE_TTL_SECONDS],
    );
  });
  return { state };
}

export class OAuthStateError extends ValidationError {
  constructor(reason: string) {
    super(`OAuth state rejected: ${reason}`);
  }
}

/**
 * Consumes a state on return from the provider. Rejected unless it exists,
 * is unused and unexpired, belongs to `userId`, matches the provider and
 * equals the cookie set when it started. Single use even on failure.
 */
export async function consumeOAuthState(userId: string, provider: string, state: string | null, cookieState: string | null) {
  if (!state || !cookieState || state.length > 200 || state !== cookieState) throw new OAuthStateError("missing or mismatched");
  const row = await withSystem((db) =>
    db.one<{ organization_id: string; app_id: string; environment_id: string; user_id: string; provider: string; return_path: string; valid: boolean }>(
      `update platform.integration_oauth_states set consumed_at = now()
        where state_hash = $1 and consumed_at is null
        returning organization_id, app_id, environment_id, user_id, provider, return_path, expires_at > now() as valid`,
      [sha(state)],
    ),
  );
  if (!row) throw new OAuthStateError("unknown or already used");
  if (!row.valid) throw new OAuthStateError("expired");
  if (row.user_id !== userId) throw new OAuthStateError("started by another user");
  if (row.provider !== provider) throw new OAuthStateError("provider mismatch");
  return row;
}

/** Finishes OAuth: exchanges the code and stores the connection (status stays unverified until a real call succeeds). */
export async function completeOAuth(ctx: TenantContext, s: { app_id: string; environment_id: string }, provider: AdProvider, code: string, redirect: string, deps: { http?: HttpOptions } = {}) {
  const result = await exchangeCode(provider, code, redirect, deps.http ?? {});
  const settings: Record<string, string> = {};
  if (result.accountIds?.length) settings.ad_account_ids = result.accountIds.join(",");
  // Google's API version is not assumed: the operator may preset one, else the customer sets it.
  const googleVersion = process.env.GOOGLE_ADS_API_VERSION ?? "";
  if (provider === "google_ads" && /^v\d{1,3}$/.test(googleVersion)) settings.api_version = googleVersion;
  return saveAdConnection(ctx, s.app_id, { environmentId: s.environment_id, provider, settings }, { authMethod: "oauth", oauthSecrets: result.secrets, scopes: result.scopes, expiresAt: result.expiresAt });
}

// ── Center overview (read-only status of everything else) ─────────────────
export interface PostbackNetworkStatus {
  network: string;
  postbacks: number;
  active: number;
  withCredentials: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  recentErrors: { at: Date; error: string; code: string | null }[];
  skipped: number;
}

/**
 * The status keys each postback reports under (see center.ts POSTBACK_KEY):
 * its network, plus "<network>:website" for Meta, TikTok and Snap website events (action_source
 * website, or auto which sends both) and "google:enhanced" for Google
 * postbacks with Enhanced Conversions (send_user_data) on.
 */
const POSTBACK_KEYS_SQL = `case
    when p.network in ('meta', 'tiktok', 'snapchat') and p.config->>'action_source' = 'website' then array[p.network || ':website']
    when p.network in ('meta', 'tiktok', 'snapchat') and p.config->>'action_source' = 'auto' then array[p.network, p.network || ':website']
    when p.network = 'google' and p.config->>'send_user_data' in ('with_consent', 'unless_denied') then array['google', 'google:enhanced']
    else array[p.network] end`;

export interface CenterData {
  connections: ConnectionView[];
  postbacks: Record<string, PostbackNetworkStatus> | null;
  adservices: { total: number; attributed: number; lastAnswerAt: Date | null; lastFailureAt: Date | null; lastError: string | null } | null;
  messaging: { provider: string; status: string; last_error: string | null; last_used_at: Date | null; live_verified_at: Date | null; updated_at: Date }[] | null;
  webhooks: { active: number; total: number; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastError: string | null } | null;
  skan: { received: number; lastAt: Date | null } | null;
  links: { links: number; lastClickAt: Date | null } | null;
  deepLinks: { configured: boolean; lastCheckedAt: Date | null } | null;
  sdk: { lastUsedAt: Date | null; activeKeys: number } | null;
}

/**
 * Everything the Integrations Center shows for one environment. Each part is
 * read only when the role may see it (null otherwise), so the center never
 * reveals more than the setup pages would.
 */
export async function centerData(ctx: TenantContext, appId: string, environmentId: string): Promise<CenterData> {
  const connections = can(ctx.role, "integrations.read") ? await listConnections(ctx, appId, environmentId) : [];
  const postbacks = can(ctx.role, "attribution.read")
    ? await tenantTx(ctx, "attribution.read", async (db) => {
        // Postbacks counted per capability key (POSTBACK_KEYS_SQL): a Meta postback for website events, or a Google one with
        // Enhanced Conversions on, also reports on that capability.
        const rows = await db.query<{ network: string; postbacks: string; active: string; with_credentials: string; last_success_at: Date | null; last_failure_at: Date | null; skipped: string }>(
          `select k.key as network, count(distinct p.id) as postbacks, count(distinct p.id) filter (where p.status = 'active') as active,
                  count(distinct p.id) filter (where p.has_credentials) as with_credentials,
                  max(d.delivered_at) as last_success_at,
                  max(d.created_at) filter (where d.status in ('failed', 'giving_up')) as last_failure_at,
                  count(d.id) filter (where d.status = 'skipped') as skipped
             from platform.attribution_postbacks p
             cross join lateral unnest(${POSTBACK_KEYS_SQL}) as k(key)
             left join platform.attribution_postback_deliveries d on d.postback_id = p.id and d.created_at > now() - interval '30 days'
            where p.app_id = $1 and p.environment_id = $2 group by k.key`,
          [appId, environmentId],
        );
        const errors = await db.query<{ network: string; created_at: Date; last_error: string; provider_error_code: string | null }>(
          `select k.key as network, d.created_at, d.last_error, d.provider_error_code
             from platform.attribution_postback_deliveries d join platform.attribution_postbacks p on p.id = d.postback_id
             cross join lateral unnest(${POSTBACK_KEYS_SQL}) as k(key)
            where p.app_id = $1 and d.environment_id = $2 and d.status in ('failed', 'giving_up') and d.last_error is not null
            order by d.created_at desc limit 30`,
          [appId, environmentId],
        );
        const out: Record<string, PostbackNetworkStatus> = {};
        for (const r of rows) {
          out[r.network] = {
            network: r.network, postbacks: Number(r.postbacks), active: Number(r.active), withCredentials: Number(r.with_credentials),
            lastSuccessAt: r.last_success_at, lastFailureAt: r.last_failure_at, skipped: Number(r.skipped),
            recentErrors: errors.filter((e) => e.network === r.network).slice(0, 3).map((e) => ({ at: e.created_at, error: e.last_error, code: e.provider_error_code })),
          };
        }
        return out;
      })
    : null;
  const messaging = can(ctx.role, "integrations.read")
    ? await tenantTx(ctx, "integrations.read", (db) =>
        db.query<NonNullable<CenterData["messaging"]>[number]>(
          "select provider, status, last_error, last_used_at, live_verified_at, updated_at from platform.integrations where environment_id = $1 order by provider",
          [environmentId],
        ))
    : null;
  const webhooks = can(ctx.role, "webhooks.manage")
    ? await tenantTx(ctx, "webhooks.manage", async (db) => {
        const w = await db.one<{ active: string; total: string; last_success_at: Date | null; last_failure_at: Date | null; last_error: string | null }>(
          `select count(*) filter (where w.status = 'active') as active, count(*) as total,
                  (select max(d.created_at) from platform.webhook_deliveries d join platform.webhooks x on x.id = d.webhook_id where x.environment_id = $1 and d.status = 'succeeded') as last_success_at,
                  (select max(d.created_at) from platform.webhook_deliveries d join platform.webhooks x on x.id = d.webhook_id where x.environment_id = $1 and d.status in ('failed', 'giving_up')) as last_failure_at,
                  (select d.last_error from platform.webhook_deliveries d join platform.webhooks x on x.id = d.webhook_id where x.environment_id = $1 and d.status in ('failed', 'giving_up') order by d.created_at desc limit 1) as last_error
             from platform.webhooks w where w.environment_id = $1`,
          [environmentId],
        );
        return { active: Number(w?.active ?? 0), total: Number(w?.total ?? 0), lastSuccessAt: w?.last_success_at ?? null, lastFailureAt: w?.last_failure_at ?? null, lastError: w?.last_error ?? null };
      })
    : null;
  const attributionReads = can(ctx.role, "attribution.read");
  const skan = attributionReads
    ? await tenantTx(ctx, "attribution.read", async (db) => {
        const r = await db.one<{ n: string; last: Date | null }>("select count(*) as n, max(received_at) as last from platform.skan_postbacks where environment_id = $1", [environmentId]);
        return { received: Number(r?.n ?? 0), lastAt: r?.last ?? null };
      })
    : null;
  const adservices = attributionReads ? await tenantTx(ctx, "attribution.read", (db) => adServicesStats(db, environmentId)) : null;
  const links = attributionReads
    ? await tenantTx(ctx, "attribution.read", async (db) => {
        const r = await db.one<{ n: string; last: Date | null }>(
          `select (select count(*) from platform.attribution_links where environment_id = $1) as n,
                  (select max(touchpoint_at) from platform.attribution_touchpoints where environment_id = $1 and provider = 'link') as last`,
          [environmentId],
        );
        return { links: Number(r?.n ?? 0), lastClickAt: r?.last ?? null };
      })
    : null;
  const deepLinks = can(ctx.role, "deep_links.read")
    ? await tenantTx(ctx, "deep_links.read", async (db) => {
        const r = await db.one<{ last_checked_at: Date | null }>("select last_checked_at from platform.deep_link_configs where environment_id = $1", [environmentId]);
        return { configured: Boolean(r), lastCheckedAt: r?.last_checked_at ?? null };
      })
    : null;
  const sdk = can(ctx.role, "credentials.read")
    ? await tenantTx(ctx, "credentials.read", async (db) => {
        const r = await db.one<{ last: Date | null; n: string }>(
          `select greatest((select max(last_used_at) from platform.sdk_keys where environment_id = $1), (select max(last_used_at) from platform.api_keys where environment_id = $1)) as last,
                  (select count(*) from platform.sdk_keys where environment_id = $1 and status = 'active') + (select count(*) from platform.api_keys where environment_id = $1 and status = 'active') as n`,
          [environmentId],
        );
        return { lastUsedAt: r?.last ?? null, activeKeys: Number(r?.n ?? 0) };
      })
    : null;
  return { connections, postbacks, adservices, messaging, webhooks, skan, links, deepLinks, sdk };
}

export { CONVERSION_NETWORK, credentialAad };
