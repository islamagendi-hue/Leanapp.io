/**
 * Database access with tenant isolation built in.
 *
 *   withTenant(ctx, fn)  Request-path work for one organization. Runs inside a
 *                        transaction as the non-owner `platform_app` role with
 *                        `app.org_id` / `app.user_id` set from the *server-derived*
 *                        TenantContext, so Postgres RLS enforces the boundary even
 *                        if a query forgets a WHERE clause.
 *   withSystem(fn)       Trusted, tenant-agnostic work (auth lookups, ingestion key
 *                        lookup, background event processing). Runs as the owning
 *                        role and bypasses RLS: every query must scope explicitly.
 *
 * See docs/multi-tenancy.md and ADR-009.
 */
import "server-only";
import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

// `date` (OID 1082) is a calendar day, not an instant: node-pg would turn it
// into local midnight, which shifts the day on servers not running in UTC.
// Keep it as the "YYYY-MM-DD" string Postgres sends.
types.setTypeParser(types.builtins.DATE, (v) => v);

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  one<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<R | null>;
}

export interface TenantScope {
  organizationId: string;
  userId: string | null;
}

let pool: Pool | null = null;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and point it at Postgres.");
  return url;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

/** Test hook: point the module at a different database. */
export async function resetPool(url?: string) {
  if (pool) await pool.end();
  pool = null;
  if (url) process.env.DATABASE_URL = url;
}

function wrap(client: PoolClient): Db {
  return {
    async query(text, values) {
      return (await client.query(text, values)).rows;
    },
    async one(text, values) {
      return (await client.query(text, values)).rows[0] ?? null;
    },
  };
}

async function transaction<T>(setup: (c: PoolClient) => Promise<void>, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function withTenant<T>(scope: TenantScope, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!UUID.test(scope.organizationId)) throw new Error("withTenant: invalid organization id");
  if (scope.userId && !UUID.test(scope.userId)) throw new Error("withTenant: invalid user id");
  return transaction(async (c) => {
    await c.query("set local role platform_app");
    await c.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [
      scope.organizationId,
      scope.userId ?? "",
    ]);
  }, fn);
}

export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return transaction(async () => {}, fn);
}

/** Postgres error code helpers. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";
export const isRlsViolation = (e: unknown) => (e as { code?: string })?.code === "42501";
