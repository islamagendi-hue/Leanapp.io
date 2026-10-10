import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withSystem, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { encryptionAvailable } from "@/lib/secret-box";
import { msg } from "@/i18n/translate";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { ProviderError, type HttpOptions } from "./ads/http";
import {
  budgetAllows, CLARITY_DAILY_LIMIT, CLARITY_DIMENSIONS, CLARITY_IMPORT_CAPABILITY, CLARITY_PROVIDER, clarityProjectUrl, fetchInsights, metricKey,
  nextDailyRun, normalizeProjectId, parseInsights, PROJECT_ID_PATTERN, REQUESTS_PER_IMPORT, utcDay, type ClarityDimension, type InsightRow,
} from "./clarity";
import type { ConnectionView } from "./service";
import { persistSecrets, readSecrets, refreshCapabilityStatus } from "./sync";
import { retryDelayMinutes } from "./status";

/**
 * Microsoft Clarity (tenant and system scope). One connection per
 * environment (provider "microsoft_clarity") holds the Data Export API token,
 * encrypted like every integration credential, and the Clarity project id
 * (not secret: it is in the site's tag). Its one stored capability,
 * "clarity_metrics_import", runs once a day from the scheduled worker and
 * on "Import now", within Clarity's 10 requests per project per day.
 * Reading needs integrations.read; changing needs integrations.manage; the
 * profile link needs users.read. docs/clarity-integration.md.
 */

export const TOKEN_LABEL = msg("Data Export API token");
const LEASE_MINUTES = 15;

async function assertEnvironment(db: Db, appId: string, environmentId: string) {
  if (!z.uuid().safeParse(environmentId).success) throw new NotFoundError("Environment");
  const env = await db.one("select 1 from platform.environments where id = $1 and app_id = $2", [environmentId, appId]);
  if (!env) throw new NotFoundError("Environment");
}

async function clarityConnection(db: Db, appId: string, connectionId: string) {
  if (!z.uuid().safeParse(connectionId).success) throw new NotFoundError("Connection");
  const row = await db.one<{ id: string; environment_id: string }>(
    "select id, environment_id from platform.integration_connections where id = $1 and app_id = $2 and provider = $3",
    [connectionId, appId, CLARITY_PROVIDER],
  );
  if (!row) throw new NotFoundError("Connection");
  return row;
}

const saveSchema = z.object({
  environmentId: z.string(),
  projectId: z.string().max(100).optional(),
  apiToken: z.string().max(4000).optional(),
});

/**
 * Creates or updates the environment's Clarity connection. A blank token
 * keeps the stored one; a blank project id removes it. Saving never turns the
 * daily import on (setClarityImport does).
 */
export async function saveClarityConnection(ctx: TenantContext, appId: string, input: unknown): Promise<{ id: string; missing: string[] }> {
  const r = saveSchema.safeParse(input);
  if (!r.success) throw new ValidationError(msg("Invalid input."));
  const projectId = normalizeProjectId(r.data.projectId);
  if (projectId && !PROJECT_ID_PATTERN.test(projectId)) {
    throw new ValidationError(`${msg("Clarity project ID")}: ${msg("check the format.")}`, { projectId: msg("Clarity project ID") });
  }
  const token = r.data.apiToken?.trim() ?? "";
  if (token && /\s/.test(token)) throw new ValidationError(`${TOKEN_LABEL}: ${msg("check the format.")}`, { apiToken: TOKEN_LABEL });
  if (token && !encryptionAvailable()) {
    throw new ValidationError(msg("Credentials can't be stored: the server has no INTEGRATIONS_ENCRYPTION_KEY configured. Ask your LeanApp administrator."));
  }

  return tenantTx(ctx, "integrations.manage", async (db) => {
    await assertEnvironment(db, appId, r.data.environmentId);
    const existing = await db.one<{ id: string; config: Record<string, string>; has_credentials: boolean }>(
      "select id, config, has_credentials from platform.integration_connections where environment_id = $1 and provider = $2",
      [r.data.environmentId, CLARITY_PROVIDER],
    );
    const id = existing?.id ?? randomUUID();
    const config: Record<string, string> = { ...(existing?.config ?? {}) };
    if (projectId) config.project_id = projectId;
    else delete config.project_id;
    const missing = token || existing?.has_credentials ? [] : [TOKEN_LABEL];
    if (!existing) {
      await db.query(
        `insert into platform.integration_connections (id, organization_id, app_id, environment_id, provider, auth_method, config, missing_fields, created_by)
         values ($1, $2, $3, $4, $5, 'manual', $6, $7, $8)`,
        [id, ctx.organizationId, appId, r.data.environmentId, CLARITY_PROVIDER, JSON.stringify(config), missing, ctx.userId],
      );
    } else {
      await db.query("update platform.integration_connections set config = $2, missing_fields = $3 where id = $1", [id, JSON.stringify(config), missing]);
    }
    await db.query(
      "insert into platform.integration_capabilities (organization_id, connection_id, capability) values ($1, $2, $3) on conflict (connection_id, capability) do nothing",
      [ctx.organizationId, id, CLARITY_IMPORT_CAPABILITY],
    );
    if (token) {
      // Encrypted and bound to this row; the tenant role may write it but never read it back.
      await persistSecrets(db, id, { api_token: token });
      // A new token: old errors no longer apply, and an auth-stopped import may resume.
      await db.query(
        `update platform.integration_capabilities set last_error = null, last_error_at = null, error_count = 0, verified_at = null,
                next_sync_at = case when enabled then now() else next_sync_at end where connection_id = $1`,
        [id],
      );
    }
    await refreshCapabilityStatus(db, id);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.connection_saved", targetType: "integration_connection", targetId: id,
      metadata: { provider: CLARITY_PROVIDER, environment_id: r.data.environmentId, settings: config, secrets_changed: token ? ["api_token"] : [], auth_method: "manual" },
    });
    return { id, missing };
  });
}

/** Turns the daily import on (first run on the worker's next pass) or off. */
export async function setClarityImport(ctx: TenantContext, appId: string, connectionId: string, enabled: boolean): Promise<void> {
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await clarityConnection(db, appId, connectionId);
    await db.query(
      `update platform.integration_capabilities set enabled = $2, next_sync_at = case when $2 then coalesce(next_sync_at, now()) else null end
        where connection_id = $1 and capability = $3`,
      [connectionId, enabled, CLARITY_IMPORT_CAPABILITY],
    );
    await refreshCapabilityStatus(db, connectionId);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.capability_updated", targetType: "integration_connection", targetId: connectionId,
      metadata: { provider: CLARITY_PROVIDER, capability: CLARITY_IMPORT_CAPABILITY, enabled },
    });
  });
}

/** "Import now": the same import as the worker, for the last 1 to 3 days. */
export async function clarityImportNow(ctx: TenantContext, appId: string, connectionId: string, numOfDays: number, deps: { http?: HttpOptions; now?: Date } = {}): Promise<ClarityImportResult> {
  const days = Number.isInteger(numOfDays) && numOfDays >= 1 && numOfDays <= 3 ? numOfDays : null;
  if (!days) throw new ValidationError(msg("Choose 1, 2 or 3 days."));
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await clarityConnection(db, appId, connectionId);
    const cap = await db.one("select 1 from platform.integration_capabilities where connection_id = $1 and capability = $2 and enabled", [connectionId, CLARITY_IMPORT_CAPABILITY]);
    if (!cap) throw new ValidationError(msg("Turn on the daily import first."));
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.sync_requested", targetType: "integration_connection", targetId: connectionId,
      metadata: { provider: CLARITY_PROVIDER, num_of_days: days },
    });
  });
  return runClarityImport(connectionId, { manual: true, numOfDays: days, http: deps.http, now: deps.now, deadline: Date.now() + 25_000 });
}

// ── Import engine (system scope) ────────────────────────────────────────────
export interface ClarityImportResult {
  ok: boolean;
  /** Not started because today's request budget is used up (no request was made). */
  budgetExhausted?: boolean;
  rows: number;
  requests: number;
  snapshotDate?: string;
  error?: string;
  errorKind?: string;
}

/**
 * Requests Clarity made today (UTC) for this connection, and for every
 * connection in the organization pointing at the same Clarity project: the
 * limit is Clarity's, per project.
 */
async function requestsToday(db: Db, organizationId: string, connectionId: string, projectId: string | null, now: Date): Promise<number> {
  const r = await db.one<{ n: string }>(
    `select coalesce(sum(r.requests), 0) as n from platform.integration_sync_runs r
       join platform.integration_connections c on c.id = r.connection_id
      where r.capability = $1 and r.started_at >= ($2::date)::timestamp at time zone 'UTC' and r.organization_id = $3
        and (c.id = $4 or ($5::text is not null and c.provider = $6 and c.config->>'project_id' = $5))`,
    [CLARITY_IMPORT_CAPABILITY, utcDay(now), organizationId, connectionId, projectId, CLARITY_PROVIDER],
  );
  return Number(r?.n ?? 0);
}

async function writeInsights(db: Db, conn: { id: string; organization_id: string; environment_id: string }, snapshot: { date: string; days: number; end: Date }, dimension: ClarityDimension, rows: InsightRow[]) {
  await db.query("delete from platform.clarity_insights where connection_id = $1 and snapshot_date = $2::date and dimension = $3", [conn.id, snapshot.date, dimension]);
  for (let i = 0; i < rows.length; i += 1000) {
    await db.query(
      `insert into platform.clarity_insights (organization_id, environment_id, connection_id, snapshot_date, num_of_days, period_end, dimension, dimension_value, metric, metric_values)
       select $1, $2, $3, $4::date, $5, $6, $7, r."dimensionValue", r.metric, r."values"
         from jsonb_to_recordset($8::jsonb) as r(metric text, "dimensionValue" text, "values" jsonb)
       on conflict (connection_id, snapshot_date, dimension, dimension_value, metric) do update
         set metric_values = excluded.metric_values, num_of_days = excluded.num_of_days, period_end = excluded.period_end, imported_at = now()`,
      [conn.organization_id, conn.environment_id, conn.id, snapshot.date, snapshot.days, snapshot.end, dimension, JSON.stringify(rows.slice(i, i + 1000))],
    );
  }
}

/**
 * One import: up to REQUESTS_PER_IMPORT requests (one per dimension), only if
 * they fit in today's budget, stopping at the first failure so a bad token
 * doesn't spend the rest. What was imported before a failure is kept.
 * Never throws for provider errors: they are recorded on the capability.
 */
export async function runClarityImport(connectionId: string, opts: { manual?: boolean; numOfDays?: number; http?: HttpOptions; now?: Date; deadline?: number } = {}): Promise<ClarityImportResult> {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(opts.numOfDays ?? 1, 1), 3);
  const snapshot = { date: utcDay(now), days, end: now };

  const start = await withSystem(async (db) => {
    const conn = await db.one<{ id: string; organization_id: string; environment_id: string; config: Record<string, string>; credentials_enc: string | null; status: string; missing_fields: string[] }>(
      "select id, organization_id, environment_id, config, credentials_enc, status, missing_fields from platform.integration_connections where id = $1 and provider = $2",
      [connectionId, CLARITY_PROVIDER],
    );
    if (!conn) return null;
    const cap = await db.one<{ id: string; enabled: boolean; error_count: number }>(
      "select id, enabled, error_count from platform.integration_capabilities where connection_id = $1 and capability = $2 for update",
      [connectionId, CLARITY_IMPORT_CAPABILITY],
    );
    if (!cap) return null;
    const projectId = normalizeProjectId(conn.config.project_id);
    // One budget per Clarity project: imports for the same project wait for each other.
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`clarity:${conn.organization_id}:${projectId ?? conn.id}`]);
    const used = await requestsToday(db, conn.organization_id, conn.id, projectId, now);
    if (!budgetAllows(used)) {
      // Nothing is sent: the scheduled import tries again tomorrow.
      if (!opts.manual) await db.query("update platform.integration_capabilities set next_sync_at = $2 where id = $1", [cap.id, nextDailyRun(now)]);
      return { conn, cap, used, run: null };
    }
    // The run reserves its requests up front, so two imports can't both fit in the same remaining budget.
    const run = await db.one<{ id: string }>(
      `insert into platform.integration_sync_runs (organization_id, connection_id, capability, kind, range_from, range_to, requests, started_at)
       values ($1, $2, $3, $4, $5::date, $6::date, $7, $8) returning id`,
      [conn.organization_id, conn.id, CLARITY_IMPORT_CAPABILITY, opts.manual ? "manual" : "incremental", utcDay(new Date(now.getTime() - days * 86_400_000)), snapshot.date, REQUESTS_PER_IMPORT, now],
    );
    await db.query("update platform.integration_capabilities set last_sync_started_at = $2 where id = $1", [cap.id, now]);
    return { conn, cap, used, run };
  });
  if (!start) return { ok: false, rows: 0, requests: 0, error: "not_configured" };
  const { conn, cap, run } = start;
  if (!run) {
    return {
      ok: false, budgetExhausted: true, rows: 0, requests: 0,
      error: `Today's Clarity budget is used up: an import needs ${REQUESTS_PER_IMPORT} of the ${CLARITY_DAILY_LIMIT} requests Clarity allows per project per day, and ${start.used} were used (UTC day).`,
    };
  }

  const budget = { remaining: REQUESTS_PER_IMPORT, used: 0 };
  const http: HttpOptions = { ...opts.http, budget, deadline: opts.deadline ?? opts.http?.deadline };
  let rows = 0;
  let failure: ProviderError | null = null;
  try {
    if (conn.status !== "active") throw new ProviderError("config", "The connection is turned off.");
    if (!conn.credentials_enc) throw new ProviderError("config", "No Clarity API token stored.");
    const token = readSecrets(conn).api_token ?? "";
    for (const dimension of CLARITY_DIMENSIONS) {
      const parsed = parseInsights(await fetchInsights(token, days, dimension, http), dimension);
      await withSystem((db) => writeInsights(db, conn, snapshot, dimension, parsed));
      rows += parsed.length;
    }
  } catch (err) {
    failure = err instanceof ProviderError
      ? err
      : new ProviderError("permanent", /INTEGRATIONS_ENCRYPTION_KEY|unable to authenticate|unrecognised secret/i.test((err as Error)?.message ?? "")
        ? "Stored credentials can't be read (encryption key missing or changed). Enter them again."
        : "Internal error during import.");
    if (!(err instanceof ProviderError)) log.warn("integrations.clarity_internal_error", { connection_id: conn.id, error: err });
  }

  await withSystem(async (db) => {
    await db.query(
      `update platform.integration_sync_runs set status = $2, rows_imported = $3, requests = $4, error_kind = $5, error = $6, finished_at = now() where id = $1`,
      [run.id, failure ? "failed" : "succeeded", rows, budget.used, failure?.kind ?? null, failure?.message.slice(0, 500) ?? null],
    );
    if (!failure) {
      await db.query(
        `update platform.integration_capabilities
            set last_success_at = $2, verified_at = $2, last_error = null, last_error_at = null, error_count = 0, status_detail = null,
                data_fresh_through = greatest(coalesce(data_fresh_through, $3::date), $3::date),
                next_sync_at = case when enabled then $4::timestamptz else null end
          where id = $1`,
        [cap.id, now, snapshot.date, nextDailyRun(now)],
      );
    } else {
      // Auth and settings problems wait for new credentials; the daily limit waits for tomorrow; others back off.
      const next = failure.kind === "auth" || failure.kind === "config" ? null
        : failure.kind === "rate_limited" ? nextDailyRun(now)
          : new Date(Math.min(now.getTime() + retryDelayMinutes(cap.error_count + 1) * 60_000, nextDailyRun(now).getTime()));
      await db.query(
        `update platform.integration_capabilities
            set last_error_at = $2, last_error = $3, error_count = error_count + 1, status_detail = $4,
                next_sync_at = case when enabled then $5::timestamptz else null end
          where id = $1`,
        [cap.id, now, failure.message.slice(0, 500), failure.kind, next],
      );
    }
    await refreshCapabilityStatus(db, conn.id);
  });
  return failure
    ? { ok: false, rows, requests: budget.used, snapshotDate: snapshot.date, error: failure.message, errorKind: failure.kind }
    : { ok: true, rows, requests: budget.used, snapshotDate: snapshot.date };
}

/** Scheduled worker step: claims due Clarity imports (at most one a day each, see nextDailyRun) and runs them. */
export async function runClaritySyncJobs(opts: { deadline?: number; limit?: number; http?: HttpOptions; now?: Date } = {}): Promise<{ imported: number; failed: number; skipped: number }> {
  const due = await withSystem((db) =>
    db.query<{ connection_id: string }>(
      `with due as (
         select c.id from platform.integration_capabilities c
           join platform.integration_connections k on k.id = c.connection_id and k.status = 'active' and k.provider = $3
          where c.capability = $4 and c.enabled and c.next_sync_at <= now()
          order by c.next_sync_at limit $1 for update of c skip locked)
       update platform.integration_capabilities c set next_sync_at = now() + make_interval(mins => $2)
         from due where c.id = due.id returning c.connection_id`,
      [Math.min(opts.limit ?? 5, 50), LEASE_MINUTES, CLARITY_PROVIDER, CLARITY_IMPORT_CAPABILITY],
    ),
  );
  const result = { imported: 0, failed: 0, skipped: 0 };
  for (const d of due) {
    if (opts.deadline && Date.now() >= opts.deadline) break; // the lease expires and a later run picks it up
    const r = await runClarityImport(d.connection_id, { http: opts.http, now: opts.now, deadline: opts.deadline });
    if (r.ok) result.imported++;
    else if (r.budgetExhausted) result.skipped++;
    else result.failed++;
  }
  return result;
}

// ── Reading ─────────────────────────────────────────────────────────────────
export interface ClarityTableRow {
  value: string;
  /** Metric name (as Clarity gave it) → numeric fields. */
  metrics: Record<string, Record<string, number>>;
}

export interface ClarityView {
  connection: ConnectionView | null;
  usedToday: number;
  snapshot: { snapshot_date: string; num_of_days: number; period_end: Date; imported_at: Date } | null;
  dimension: ClarityDimension;
  rows: ClarityTableRow[];
  /** Metrics present in this snapshot, in Clarity's names. */
  metrics: string[];
  /** Sessions per snapshot (Traffic, summed over devices), newest first. */
  history: { snapshot_date: string; num_of_days: number; sessions: number | null }[];
}

const CAP_COLUMNS = `id, connection_id, capability, enabled, config, status, status_detail, verified_at, last_sync_started_at, last_success_at, last_error_at, last_error,
  data_fresh_through::text as data_fresh_through, next_sync_at, backfill_from::text as backfill_from, backfill_cursor::text as backfill_cursor`;

/** Everything the Clarity page shows for one environment and dimension. */
export async function clarityView(ctx: TenantContext, appId: string, environmentId: string, dimension: ClarityDimension, opts: { now?: Date; limit?: number } = {}): Promise<ClarityView> {
  return tenantTx(ctx, "integrations.read", async (db) => {
    await assertEnvironment(db, appId, environmentId);
    const conn = await db.one<Omit<ConnectionView, "capabilities">>(
      `select id, environment_id, provider, auth_method, config, has_credentials, credentials_updated_at, token_expires_at, granted_scopes, missing_fields, status
         from platform.integration_connections where environment_id = $1 and provider = $2`,
      [environmentId, CLARITY_PROVIDER],
    );
    const empty: ClarityView = { connection: null, usedToday: 0, snapshot: null, dimension, rows: [], metrics: [], history: [] };
    if (!conn) return empty;
    const caps = await db.query<ConnectionView["capabilities"][number]>(`select ${CAP_COLUMNS} from platform.integration_capabilities where connection_id = $1`, [conn.id]);
    const connection: ConnectionView = { ...conn, capabilities: caps };
    const used = await db.one<{ n: string }>(
      "select coalesce(sum(requests), 0) as n from platform.integration_sync_runs where connection_id = $1 and capability = $2 and started_at >= ($3::date)::timestamp at time zone 'UTC'",
      [conn.id, CLARITY_IMPORT_CAPABILITY, utcDay(opts.now ?? new Date())],
    );
    const snapshot = await db.one<NonNullable<ClarityView["snapshot"]>>(
      `select snapshot_date::text as snapshot_date, num_of_days, period_end, max(imported_at) as imported_at from platform.clarity_insights
        where connection_id = $1 and dimension = $2 group by snapshot_date, num_of_days, period_end order by snapshot_date desc, period_end desc limit 1`,
      [conn.id, dimension],
    );
    const raw = snapshot
      ? await db.query<{ dimension_value: string; metric: string; metric_values: Record<string, number> }>(
          "select dimension_value, metric, metric_values from platform.clarity_insights where connection_id = $1 and dimension = $2 and snapshot_date = $3::date",
          [conn.id, dimension, snapshot.snapshot_date],
        )
      : [];
    const byValue = new Map<string, ClarityTableRow>();
    const metrics = new Set<string>();
    for (const r of raw) {
      metrics.add(r.metric);
      const row = byValue.get(r.dimension_value) ?? { value: r.dimension_value, metrics: {} };
      row.metrics[r.metric] = r.metric_values;
      byValue.set(r.dimension_value, row);
    }
    const sessions = (row: ClarityTableRow) => {
      const traffic = Object.entries(row.metrics).find(([m]) => metricKey(m) === "traffic")?.[1];
      return traffic?.totalSessionCount ?? -1;
    };
    const rows = [...byValue.values()].sort((a, b) => sessions(b) - sessions(a) || a.value.localeCompare(b.value)).slice(0, opts.limit ?? 50);
    const history = await db.query<{ snapshot_date: string; num_of_days: number; sessions: string | null }>(
      `select snapshot_date::text as snapshot_date, max(num_of_days) as num_of_days,
              sum((metric_values->>'totalSessionCount')::numeric) filter (where lower(metric) = 'traffic' and jsonb_typeof(metric_values->'totalSessionCount') = 'number') as sessions
         from platform.clarity_insights where connection_id = $1 and dimension = 'Device'
        group by snapshot_date order by snapshot_date desc limit 14`,
      [conn.id],
    );
    return {
      connection, usedToday: Number(used?.n ?? 0), snapshot, dimension, rows, metrics: [...metrics],
      history: history.map((h) => ({ snapshot_date: h.snapshot_date, num_of_days: h.num_of_days, sessions: h.sessions === null ? null : Number(h.sessions) })),
    };
  });
}

/**
 * The Clarity project link for a user profile, or null when no Clarity
 * project id is set for the environment. Needs users.read (the profile's own
 * permission): the project id is not a secret.
 */
export async function clarityProfileLink(ctx: TenantContext, appId: string, environmentId: string): Promise<{ url: string; projectId: string } | null> {
  return tenantTx(ctx, "users.read", async (db) => {
    await assertEnvironment(db, appId, environmentId);
    const row = await db.one<{ project_id: string | null }>(
      "select config->>'project_id' as project_id from platform.integration_connections where environment_id = $1 and provider = $2 and status = 'active'",
      [environmentId, CLARITY_PROVIDER],
    );
    const projectId = normalizeProjectId(row?.project_id);
    const url = projectId ? clarityProjectUrl(projectId) : null;
    return url && projectId ? { url, projectId } : null;
  });
}
