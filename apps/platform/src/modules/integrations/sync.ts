import "server-only";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";
import { purgeReportCache } from "@/modules/analytics/cache";
import { localDate } from "@/modules/analytics/range";
import { AD_ADAPTERS } from "./ads";
import { ProviderError, type HttpOptions } from "./ads/http";
import type { AdAccount, AdDailyRow, Secrets, Settings } from "./ads/types";
import { isAdProvider, type AdProvider } from "./registry";
import { deriveStatus, planSync, retryDelayMinutes, SYNC_INTERVAL_HOURS } from "./status";

/**
 * Inbound ad reporting sync (system scope; run by the scheduled worker and by
 * "Sync now"). For one connection's `ad_reporting` capability:
 *   1. plan the day range (backfill chunk, else incremental with restatement days)
 *   2. prepare the adapter (token refresh; rotated secrets are re-encrypted)
 *   3. list ad accounts and keep the chosen ones
 *   4. page through daily rows per account
 *   5. replace ad_performance_daily for the range, upsert ad_entities
 *   6. when `spend_import` is on: replace this connection's imported rows in
 *      ad_spend_daily for the range, never touching hand-entered ones
 *   7. record the run and the capability's status, freshness and next run
 * Failures: auth errors stop scheduling until credentials change; others retry
 * with backoff (15 min, 1 h, 6 h, 24 h).
 */
export const credentialAad = (connectionId: string) => `integration_connection:${connectionId}`;

const LEASE_MINUTES = 15;
const MAX_PAGES_PER_ACCOUNT = 200;
const REQUEST_BUDGET = 400;

interface CapRow {
  id: string;
  organization_id: string;
  connection_id: string;
  enabled: boolean;
  data_fresh_through: string | null;
  backfill_from: string | null;
  backfill_cursor: string | null;
  error_count: number;
  verified_at: Date | null;
  last_success_at: Date | null;
}

interface ConnRow {
  id: string;
  organization_id: string;
  environment_id: string;
  provider: string;
  config: Settings;
  credentials_enc: string | null;
  missing_fields: string[];
  status: string;
  timezone: string;
}

export interface SyncResult {
  ok: boolean;
  kind?: "incremental" | "backfill" | "manual";
  from?: string;
  to?: string;
  rows: number;
  spendRows: number;
  spendSkipped: number;
  error?: string;
  errorKind?: string;
}

export interface SyncDeps {
  http?: HttpOptions;
  /** Today in the app's timezone (tests). */
  today?: string;
}

async function loadConnection(db: Db, connectionId: string): Promise<ConnRow | null> {
  return db.one<ConnRow>(
    `select c.id, c.organization_id, c.environment_id, c.provider, c.config, c.credentials_enc, c.missing_fields, c.status, a.timezone
       from platform.integration_connections c join platform.apps a on a.id = c.app_id
      where c.id = $1`,
    [connectionId],
  );
}

/** Decrypted secrets of a connection (system scope only). */
export function readSecrets(conn: { id: string; credentials_enc: string | null }): Secrets {
  return conn.credentials_enc ? (JSON.parse(decryptSecret(conn.credentials_enc, credentialAad(conn.id))) as Secrets) : {};
}

export async function persistSecrets(db: Db, connectionId: string, secrets: Secrets, expiresAt?: Date | null) {
  await db.query(
    "update platform.integration_connections set credentials_enc = $2, credentials_updated_at = now(), token_expires_at = coalesce($3, token_expires_at) where id = $1",
    [connectionId, encryptSecret(JSON.stringify(secrets), credentialAad(connectionId)), expiresAt ?? null],
  );
}

/** Ids chosen in settings (`ad_account_ids`), normalised per provider. */
export function chosenAccounts(provider: AdProvider, settings: Settings): string[] {
  const raw = (settings.ad_account_ids ?? "").split(/[\s,]+/).filter(Boolean);
  if (provider === "snapchat_ads") return raw.map((x) => x.toLowerCase());
  return raw.map((x) => x.replace(/\D/g, "")).filter(Boolean);
}

/**
 * The accounts to import: the chosen ids, with metadata from the provider's
 * listing when it has them. A chosen id the listing doesn't include is an
 * error (the credentials can't read it), except for Google, whose listing has
 * only accounts directly accessible (manager accounts reach more).
 */
export function resolveAccounts(provider: AdProvider, chosen: string[], listed: AdAccount[]): { accounts: AdAccount[]; unreadable: string[] } {
  const byId = new Map(listed.map((a) => [provider === "snapchat_ads" ? a.id.toLowerCase() : a.id, a]));
  const accounts: AdAccount[] = [];
  const unreadable: string[] = [];
  for (const id of chosen) {
    const a = byId.get(id);
    if (a) accounts.push(a);
    else if (provider === "google_ads") accounts.push({ id, name: null, currency: null, timezone: null });
    else unreadable.push(id);
  }
  return { accounts, unreadable };
}

/** One row per day and ad object (providers may split a row, e.g. by currency changes or paging overlap): metrics are summed. */
export function mergeRows(rows: AdDailyRow[]): AdDailyRow[] {
  const out = new Map<string, AdDailyRow>();
  for (const r of rows) {
    const key = [r.day, r.accountId, r.campaignId, r.adsetId, r.adId].join("\u0000");
    const cur = out.get(key);
    if (!cur) out.set(key, { ...r });
    else {
      cur.impressions += r.impressions;
      cur.clicks += r.clicks;
      cur.spend += r.spend;
      cur.conversions = cur.conversions === null && r.conversions === null ? null : (cur.conversions ?? 0) + (r.conversions ?? 0);
    }
  }
  return [...out.values()];
}

/** Daily cost per campaign for Ad spend: one row per day, campaign label and currency. */
export function spendAggregate(rows: Pick<AdDailyRow, "day" | "campaignId" | "campaignName" | "currency" | "spend">[]) {
  const out = new Map<string, { day: string; campaign: string; currency: string; amount: number }>();
  for (const r of rows) {
    const campaign = (r.campaignName?.trim() || r.campaignId).slice(0, 100);
    const key = [r.day, campaign, r.currency].join("\u0000");
    const cur = out.get(key) ?? { day: r.day, campaign, currency: r.currency, amount: 0 };
    cur.amount += r.spend;
    out.set(key, cur);
  }
  return [...out.values()].map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100 }));
}

async function setCapability(db: Db, capId: string, fields: { ok: boolean; error?: string; kind?: string; freshThrough?: string | null; failures?: number; auth?: boolean; backfill?: { from: string; done: boolean } | null; more?: boolean }) {
  if (fields.ok) {
    await db.query(
      `update platform.integration_capabilities
          set last_success_at = now(), verified_at = now(), last_error = null, error_count = 0, status = 'verified', status_detail = null,
              data_fresh_through = case when $2::date is null then data_fresh_through else greatest(coalesce(data_fresh_through, $2::date), $2::date) end,
              backfill_cursor = case when $3::date is null then backfill_cursor when $4 then null else $3::date end,
              backfill_from = case when $4 then null else backfill_from end,
              next_sync_at = case when $6 then now() else now() + make_interval(hours => $5) end
        where id = $1`,
      [capId, fields.freshThrough ?? null, fields.backfill?.from ?? null, fields.backfill?.done ?? false, SYNC_INTERVAL_HOURS, fields.more ?? false],
    );
  } else {
    await db.query(
      `update platform.integration_capabilities
          set last_error_at = now(), last_error = $2, error_count = error_count + 1, status = 'error', status_detail = $3,
              next_sync_at = case when $4 then null else now() + make_interval(mins => $5) end
        where id = $1`,
      [capId, fields.error?.slice(0, 500) ?? "failed", fields.kind ?? null, fields.auth ?? false, retryDelayMinutes((fields.failures ?? 0) + 1)],
    );
  }
}

async function writeRows(db: Db, conn: ConnRow, account: AdAccount, from: string, to: string, rows: AdDailyRow[]) {
  await db.query(
    `delete from platform.ad_performance_daily where connection_id = $1 and account_id = $2 and day between $3::date and $4::date`,
    [conn.id, account.id, from, to],
  );
  const merged = mergeRows(rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && /^[A-Z]{3}$/.test(r.currency)));
  for (let i = 0; i < merged.length; i += 2000) {
    await db.query(
      `insert into platform.ad_performance_daily (organization_id, environment_id, connection_id, provider, day, account_id, campaign_id, campaign_name,
                                                  adset_id, adset_name, ad_id, ad_name, currency, impressions, clicks, spend, conversions)
       select $1, $2, $3, $4, r.day, r."accountId", r."campaignId", r."campaignName", r."adsetId", r."adsetName", r."adId", r."adName",
              r.currency, r.impressions, r.clicks, r.spend, r.conversions
         from jsonb_to_recordset($5::jsonb) as r(day date, "accountId" text, "campaignId" text, "campaignName" text, "adsetId" text, "adsetName" text,
                                                "adId" text, "adName" text, currency text, impressions bigint, clicks bigint, spend numeric, conversions numeric)
       on conflict (connection_id, day, account_id, campaign_id, adset_id, ad_id) do update
         set impressions = excluded.impressions, clicks = excluded.clicks, spend = excluded.spend, conversions = excluded.conversions,
             campaign_name = excluded.campaign_name, adset_name = excluded.adset_name, ad_name = excluded.ad_name, imported_at = now()`,
      [conn.organization_id, conn.environment_id, conn.id, conn.provider, JSON.stringify(merged.slice(i, i + 2000))],
    );
  }
  // External ids and names of what was seen.
  const entities = new Map<string, { level: string; id: string; parent: string | null; name: string | null }>();
  entities.set(`account:${account.id}`, { level: "account", id: account.id, parent: null, name: account.name });
  for (const r of rows) {
    if (r.campaignId) entities.set(`campaign:${r.campaignId}`, { level: "campaign", id: r.campaignId, parent: account.id, name: r.campaignName });
    if (r.adsetId) entities.set(`adset:${r.adsetId}`, { level: "adset", id: r.adsetId, parent: r.campaignId, name: r.adsetName });
    if (r.adId) entities.set(`ad:${r.adId}`, { level: "ad", id: r.adId, parent: r.adsetId || r.campaignId, name: r.adName });
  }
  const list = [...entities.values()].filter((e) => e.id.length <= 100);
  for (let i = 0; i < list.length; i += 2000) {
    await db.query(
      `insert into platform.ad_entities (organization_id, environment_id, connection_id, provider, level, external_id, parent_external_id, account_external_id, name, currency, timezone)
       select $1, $2, $3, $4, e.level, e.id, e.parent, $5, e.name, $6, $7 from jsonb_to_recordset($8::jsonb) as e(level text, id text, parent text, name text)
       on conflict (connection_id, level, external_id) do update
         set name = coalesce(excluded.name, ad_entities.name), parent_external_id = coalesce(excluded.parent_external_id, ad_entities.parent_external_id),
             currency = coalesce(excluded.currency, ad_entities.currency), timezone = coalesce(excluded.timezone, ad_entities.timezone), last_seen_at = now()`,
      [conn.organization_id, conn.environment_id, conn.id, conn.provider, account.id, account.currency, account.timezone, JSON.stringify(list.slice(i, i + 2000))],
    );
  }
}

/** Replaces this connection's imported spend for the range; returns [written, skipped because entered by hand]. */
async function writeSpend(db: Db, conn: ConnRow, source: string, from: string, to: string): Promise<[number, number]> {
  const rows = await db.query<{ day: string; campaign_id: string; campaign_name: string | null; currency: string; spend: string }>(
    `select day::text as day, campaign_id, max(campaign_name) as campaign_name, currency, sum(spend)::text as spend
       from platform.ad_performance_daily where connection_id = $1 and day between $2::date and $3::date
      group by day, campaign_id, currency`,
    [conn.id, from, to],
  );
  const agg = spendAggregate(rows.map((r) => ({ day: r.day, campaignId: r.campaign_id, campaignName: r.campaign_name, currency: r.currency, spend: Number(r.spend) })));
  await db.query(
    "delete from platform.ad_spend_daily where connection_id = $1 and origin = 'import' and day between $2::date and $3::date",
    [conn.id, from, to],
  );
  if (!agg.length) return [0, 0];
  const inserted = await db.query(
    `insert into platform.ad_spend_daily (organization_id, environment_id, day, source, campaign, currency, amount, origin, connection_id)
     select $1, $2, r.day, $3, r.campaign, r.currency, r.amount, 'import', $4
       from jsonb_to_recordset($5::jsonb) as r(day date, campaign text, currency text, amount numeric)
     on conflict (environment_id, day, source, campaign, currency) do update
       set amount = excluded.amount, connection_id = excluded.connection_id
       where ad_spend_daily.origin = 'import'
     returning 1`,
    [conn.organization_id, conn.environment_id, source, conn.id, JSON.stringify(agg)],
  );
  await purgeReportCache(db, conn.environment_id);
  return [inserted.length, agg.length - inserted.length];
}

/** Writes Ad spend from everything already imported for a connection (when cost import is turned on). */
export async function rebuildSpend(connectionId: string, source: string): Promise<[number, number]> {
  return withSystem(async (db) => {
    const conn = await loadConnection(db, connectionId);
    if (!conn) return [0, 0] as [number, number];
    const range = await db.one<{ from: string | null; to: string | null }>(
      "select min(day)::text as from, max(day)::text as to from platform.ad_performance_daily where connection_id = $1",
      [connectionId],
    );
    if (!range?.from || !range.to) return [0, 0] as [number, number];
    return writeSpend(db, conn, source, range.from, range.to);
  });
}

/** Removes a connection's imported spend (when cost import is turned off). Hand-entered spend is untouched. */
export async function removeImportedSpend(db: Db, connectionId: string, environmentId: string): Promise<number> {
  const rows = await db.query("delete from platform.ad_spend_daily where connection_id = $1 and origin = 'import' returning 1", [connectionId]);
  if (rows.length) await purgeReportCache(db, environmentId);
  return rows.length;
}

/** Runs one sync of a connection's ad reporting. Never throws for provider errors: they are recorded. */
export async function syncConnection(connectionId: string, opts: { manual?: boolean; deadline?: number } & SyncDeps = {}): Promise<SyncResult> {
  const ctx = await withSystem(async (db) => {
    const conn = await loadConnection(db, connectionId);
    if (!conn || !isAdProvider(conn.provider)) return null;
    const caps = await db.query<CapRow & { capability: string; config: Settings }>(
      `select id, organization_id, connection_id, capability, enabled, config, data_fresh_through::text as data_fresh_through, backfill_from::text as backfill_from,
              backfill_cursor::text as backfill_cursor, error_count, verified_at, last_success_at
         from platform.integration_capabilities where connection_id = $1`,
      [connectionId],
    );
    return { conn, reporting: caps.find((c) => c.capability === "ad_reporting"), spend: caps.find((c) => c.capability === "spend_import") };
  });
  if (!ctx?.reporting) return { ok: false, rows: 0, spendRows: 0, spendSkipped: 0, error: "not_configured" };
  const { conn, reporting, spend } = ctx;
  const provider = conn.provider as AdProvider;
  const adapter = AD_ADAPTERS[provider];
  const today = opts.today ?? localDate(new Date(), conn.timezone || "UTC");
  const plan = planSync({ today, freshThrough: reporting.data_fresh_through, backfillFrom: reporting.backfill_from, backfillCursor: reporting.backfill_cursor });
  const kind: NonNullable<SyncResult["kind"]> = opts.manual && plan.kind === "incremental" ? "manual" : plan.kind;
  const budget = { remaining: REQUEST_BUDGET, used: 0 };
  const http: HttpOptions = { ...opts.http, budget, deadline: opts.deadline ?? opts.http?.deadline };

  const run = await withSystem((db) =>
    db.one<{ id: string }>(
      `insert into platform.integration_sync_runs (organization_id, connection_id, capability, kind, range_from, range_to) values ($1, $2, 'ad_reporting', $3, $4, $5) returning id`,
      [conn.organization_id, conn.id, kind, plan.from, plan.to],
    ),
  );
  await withSystem((db) => db.query("update platform.integration_capabilities set last_sync_started_at = now() where id = $1", [reporting.id]));

  const finish = async (r: SyncResult) => {
    await withSystem(async (db) => {
      await db.query(
        `update platform.integration_sync_runs set status = $2, rows_imported = $3, spend_rows = $4, spend_skipped = $5, requests = $6, error_kind = $7, error = $8, finished_at = now() where id = $1`,
        [run!.id, r.ok ? "succeeded" : "failed", r.rows, r.spendRows, r.spendSkipped, budget.used, r.errorKind ?? null, r.error?.slice(0, 500) ?? null],
      );
    });
    return { ...r, kind, from: plan.from, to: plan.to };
  };

  try {
    if (conn.status !== "active") throw new ProviderError("config", "The connection is turned off.");
    if (conn.missing_fields.length) throw new ProviderError("config", `Missing: ${conn.missing_fields.join(", ")}`);
    const secrets = readSecrets(conn);
    const session = await adapter.prepare(secrets, conn.config, http);
    if (session.updatedSecrets) await withSystem((db) => persistSecrets(db, conn.id, session.updatedSecrets!, session.expiresAt));
    const chosen = chosenAccounts(provider, conn.config);
    if (!chosen.length) throw new ProviderError("config", "Choose at least one ad account.");
    const { accounts, unreadable } = resolveAccounts(provider, chosen, await adapter.listAccounts(session, conn.config, http));
    if (unreadable.length) throw new ProviderError("auth", `These ad accounts can't be read with the stored credentials: ${unreadable.join(", ")}`);

    const perAccount: { account: AdAccount; rows: AdDailyRow[] }[] = [];
    for (const account of accounts) {
      const rows: AdDailyRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
        const p = await adapter.report(session, conn.config, { account, from: plan.from, to: plan.to, cursor }, http);
        rows.push(...p.rows);
        if (!p.next) break;
        cursor = p.next;
        if (page === MAX_PAGES_PER_ACCOUNT - 1) throw new ProviderError("transient", "Too many pages in one run; the next run continues.");
      }
      perAccount.push({ account, rows });
    }

    const source = (spend?.config?.spend_source || adapter.defaultSpendSource).toLowerCase().slice(0, 100);
    const [spendRows, spendSkipped] = await withSystem(async (db) => {
      for (const { account, rows } of perAccount) await writeRows(db, conn, account, plan.from, plan.to, rows);
      return spend?.enabled ? writeSpend(db, conn, source, plan.from, plan.to) : ([0, 0] as [number, number]);
    });
    const rows = perAccount.reduce((n, a) => n + a.rows.length, 0);
    await withSystem(async (db) => {
      await setCapability(db, reporting.id, {
        ok: true,
        freshThrough: plan.kind === "incremental" ? plan.to : null,
        backfill: plan.kind === "backfill" ? { from: plan.from, done: plan.from <= (reporting.backfill_from ?? plan.from) } : null,
        // More to do right away: the rest of a backfill, or catching up to today after a pause.
        more: plan.kind === "backfill" ? plan.from > (reporting.backfill_from ?? plan.from) : plan.to < today,
      });
      if (spend?.enabled) {
        await db.query(
          `update platform.integration_capabilities set last_success_at = now(), verified_at = now(), last_error = null, error_count = 0, status = 'verified', status_detail = null,
                  data_fresh_through = case when $2::date is null then data_fresh_through else greatest(coalesce(data_fresh_through, $2::date), $2::date) end
            where id = $1`,
          [spend.id, plan.kind === "incremental" ? plan.to : null],
        );
      }
    });
    return finish({ ok: true, rows, spendRows, spendSkipped });
  } catch (err) {
    const pe = err instanceof ProviderError ? err : null;
    const message = pe ? pe.message : (err as Error).message?.includes("INTEGRATIONS_ENCRYPTION_KEY") || /unrecognised secret|unable to authenticate/i.test((err as Error).message ?? "") ? "Stored credentials can't be read (encryption key missing or changed). Enter them again." : "Internal error during sync.";
    const errorKind = pe?.kind ?? "permanent";
    if (!pe) log.warn("integrations.sync_internal_error", { connection_id: conn.id, error: err });
    await withSystem(async (db) => {
      await setCapability(db, reporting.id, { ok: false, error: message, kind: errorKind, failures: reporting.error_count, auth: errorKind === "auth" || errorKind === "config" });
      if (spend?.enabled) {
        await db.query(
          "update platform.integration_capabilities set last_error_at = now(), last_error = $2, status = 'error', status_detail = 'ad_reporting' where id = $1",
          [spend.id, `Ad reporting import failed: ${message}`.slice(0, 500)],
        );
      }
    });
    return finish({ ok: false, rows: 0, spendRows: 0, spendSkipped: 0, error: message, errorKind });
  }
}

/** Scheduled worker step: claims due ad-reporting capabilities and syncs them, until the deadline. */
export async function runAdSyncJobs(opts: { deadline?: number; limit?: number } & SyncDeps = {}): Promise<{ synced: number; failed: number }> {
  const due = await withSystem((db) =>
    db.query<{ connection_id: string }>(
      `with due as (
         select c.id from platform.integration_capabilities c
           join platform.integration_connections k on k.id = c.connection_id and k.status = 'active'
          where c.capability = 'ad_reporting' and c.enabled and c.next_sync_at <= now()
          order by c.next_sync_at limit $1 for update of c skip locked)
       update platform.integration_capabilities c set next_sync_at = now() + make_interval(mins => $2)
         from due where c.id = due.id returning c.connection_id`,
      [Math.min(opts.limit ?? 10, 50), LEASE_MINUTES],
    ),
  );
  const result = { synced: 0, failed: 0 };
  for (const d of due) {
    if (opts.deadline && Date.now() >= opts.deadline) break; // the lease expires and a later run picks it up
    const r = await syncConnection(d.connection_id, opts);
    if (r.ok) result.synced++;
    else result.failed++;
  }
  return result;
}

/** Recomputes a capability's stored status from its fields (after settings change). */
export async function refreshCapabilityStatus(db: Db, connectionId: string): Promise<void> {
  const conn = await db.one<{ has_credentials: boolean; missing_fields: string[]; status: string }>(
    "select has_credentials, missing_fields, status from platform.integration_connections where id = $1",
    [connectionId],
  );
  if (!conn) return;
  const caps = await db.query<{ id: string; enabled: boolean; verified_at: Date | null; last_success_at: Date | null; last_error_at: Date | null }>(
    "select id, enabled, verified_at, last_success_at, last_error_at from platform.integration_capabilities where connection_id = $1",
    [connectionId],
  );
  for (const c of caps) {
    const status = deriveStatus({
      enabled: c.enabled && conn.status === "active",
      complete: conn.has_credentials && conn.missing_fields.length === 0,
      verifiedAt: c.verified_at, lastSuccessAt: c.last_success_at, lastErrorAt: c.last_error_at,
    });
    await db.query("update platform.integration_capabilities set status = $2, status_detail = case when $2 = 'credentials_missing' then $3 else status_detail end where id = $1", [c.id, status, conn.missing_fields.join(", ") || null]);
  }
}
