import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { msg } from "@/i18n/translate";
import { purgeReportCache } from "@/modules/analytics/cache";
import { localDate } from "@/modules/analytics/range";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { parseSpendCsv, validateSpend, type CsvRowError, type SpendInput } from "./spend-pure";

/**
 * Ad spend per environment and day, entered by hand or by CSV
 * (platform.ad_spend_daily, migration 0031). Days are calendar days in the
 * app's timezone, like the reports. Saving the same day, source, campaign and
 * currency again replaces the amount. Changing spend needs attribution.manage
 * and is audited; reading it needs analytics.read, like the Revenue report
 * that uses it. Automatic import from ad networks is not built.
 */

export interface SpendRow {
  id: string;
  date: string;
  source: string;
  /** null when not for one campaign. */
  campaign: string | null;
  currency: string;
  amount: number;
  updated_at: Date;
}

interface Scope {
  appId: string;
  environmentId: string;
  /** The app's timezone: no spend for a day that hasn't started there. */
  timezone: string;
}

async function assertEnvironment(db: Db, appId: string, environmentId: string) {
  if (!z.uuid().safeParse(environmentId).success) throw new NotFoundError("Environment");
  const env = await db.one("select 1 from platform.environments where id = $1 and app_id = $2", [environmentId, appId]);
  if (!env) throw new NotFoundError("Environment");
}

async function upsert(db: Db, ctx: TenantContext, environmentId: string, rows: SpendInput[]) {
  if (!rows.length) return;
  await db.query(
    `insert into platform.ad_spend_daily (organization_id, environment_id, day, source, campaign, currency, amount, created_by, updated_by)
     select $1, $2, r.day, r.source, r.campaign, r.currency, r.amount, $3, $3
       from unnest($4::date[], $5::text[], $6::text[], $7::text[], $8::numeric[]) as r(day, source, campaign, currency, amount)
     on conflict (environment_id, day, source, campaign, currency)
     do update set amount = excluded.amount, updated_by = excluded.updated_by`,
    [ctx.organizationId, environmentId, ctx.userId, rows.map((r) => r.date), rows.map((r) => r.source), rows.map((r) => r.campaign), rows.map((r) => r.currency), rows.map((r) => r.amount)],
  );
  // The Revenue report shows spend: drop cached results so it shows the change at once.
  await purgeReportCache(db, environmentId);
}

/** Spend entries of an environment, newest day first (at most `limit`). */
export async function listSpend(ctx: TenantContext, environmentId: string, opts: { limit?: number } = {}): Promise<SpendRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  return tenantTx(ctx, "analytics.read", async (db) => {
    const rows = await db.query<{ id: string; date: string; source: string; campaign: string; currency: string; amount: string; updated_at: Date }>(
      `select id, day::text as date, source, campaign, currency, amount::text as amount, updated_at
         from platform.ad_spend_daily where environment_id = $1
        order by day desc, source, campaign, currency limit $2`,
      [environmentId, limit],
    );
    return rows.map((r) => ({ ...r, campaign: r.campaign || null, amount: Number(r.amount) }));
  });
}

/** Sources seen in the environment's installs, to pick from when entering spend. */
export async function knownSources(ctx: TenantContext, environmentId: string): Promise<string[]> {
  return tenantTx(ctx, "analytics.read", async (db) => {
    const rows = await db.query<{ source: string }>(
      `select source from (select distinct source from platform.attribution_events where environment_id = $1 and source is not null
                           union select distinct source from platform.attribution_links where environment_id = $1) s
        order by source limit 200`,
      [environmentId],
    );
    return rows.map((r) => r.source);
  });
}

/** Saves one day's spend for a source (and campaign) in a currency, replacing what was there. */
export async function saveSpend(ctx: TenantContext, scope: Scope, input: unknown): Promise<SpendInput> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const r = validateSpend(raw, localDate(new Date(), scope.timezone));
  if (!r.ok) throw new ValidationError(r.error, { [r.field]: r.error });
  await tenantTx(ctx, "attribution.manage", async (db) => {
    await assertEnvironment(db, scope.appId, scope.environmentId);
    await upsert(db, ctx, scope.environmentId, [r.value]);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.spend_saved", targetType: "environment", targetId: scope.environmentId,
      metadata: { ...r.value, campaign: r.value.campaign || null },
    });
  });
  return r.value;
}

/**
 * Imports spend CSV (date,source,campaign,currency,amount). Nothing is saved
 * when any row is wrong: the errors name each line. Returns how many entries
 * were saved.
 */
export async function importSpendCsv(ctx: TenantContext, scope: Scope, csv: string): Promise<{ imported: number; errors: CsvRowError[] }> {
  if (typeof csv !== "string" || csv.length > 1_000_000) throw new ValidationError(msg("The CSV is too large: import at most 1 MB at a time."));
  const { rows, errors } = parseSpendCsv(csv, localDate(new Date(), scope.timezone));
  return tenantTx(ctx, "attribution.manage", async (db) => {
    await assertEnvironment(db, scope.appId, scope.environmentId);
    if (errors.length) return { imported: 0, errors };
    await upsert(db, ctx, scope.environmentId, rows);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.spend_imported", targetType: "environment", targetId: scope.environmentId,
      metadata: { rows: rows.length, from: rows.reduce((a, x) => (x.date < a ? x.date : a), rows[0].date), to: rows.reduce((a, x) => (x.date > a ? x.date : a), rows[0].date) },
    });
    return { imported: rows.length, errors: [] };
  });
}

/** Deletes one spend entry of the app. */
export async function deleteSpend(ctx: TenantContext, appId: string, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Spend entry");
  await tenantTx(ctx, "attribution.manage", async (db) => {
    const row = await db.one<{ environment_id: string; date: string; source: string; campaign: string; currency: string; amount: string }>(
      `delete from platform.ad_spend_daily s using platform.environments e
        where s.id = $1 and e.id = s.environment_id and e.app_id = $2
        returning s.environment_id, s.day::text as date, s.source, s.campaign, s.currency, s.amount::text as amount`,
      [id, appId],
    );
    if (!row) throw new NotFoundError("Spend entry");
    await purgeReportCache(db, row.environment_id);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "attribution.spend_deleted", targetType: "ad_spend", targetId: id,
      metadata: { ...row, campaign: row.campaign || null, amount: Number(row.amount) },
    });
  });
}

/**
 * Spend per source and currency over calendar days `from`..`to` (inclusive),
 * for the Revenue report's channel breakdown. Runs in the caller's
 * transaction (the report's, under analytics.read).
 */
export async function spendBySource(db: Db, environmentId: string, from: string, to: string): Promise<{ source: string; currency: string; amount: number }[]> {
  const rows = await db.query<{ source: string; currency: string; amount: string }>(
    `select source, currency, sum(amount)::text as amount from platform.ad_spend_daily
      where environment_id = $1 and day between $2::date and $3::date
      group by source, currency`,
    [environmentId, from, to],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}
