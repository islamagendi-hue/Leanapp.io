import "server-only";
import { withSystem } from "./db";

/**
 * Fixed-window rate limiter backed by Postgres, so the limit holds across
 * serverless instances. One upsert per check. Swap for Redis (INCR + EXPIRE)
 * when request volume makes this table hot: see docs/infrastructure.md.
 *
 * Returns the number of seconds to wait, or 0 when the request is allowed.
 */
export async function consumeRateLimit(key: string, limit: number, windowSeconds: number, cost = 1): Promise<number> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const row = await withSystem((db) =>
    db.one<{ count: number }>(
      `insert into platform.rate_limit_buckets (key, window_start, count) values ($1, $2, $3)
       on conflict (key, window_start) do update set count = platform.rate_limit_buckets.count + excluded.count
       returning count`,
      [key, windowStart, cost],
    ),
  );
  if ((row?.count ?? 0) <= limit) return 0;
  return Math.max(1, Math.ceil((windowStart.getTime() + windowSeconds * 1000 - now) / 1000));
}

/** Deletes expired windows. Called from the scheduled maintenance job. */
export async function purgeRateLimitBuckets(): Promise<number> {
  const rows = await withSystem((db) =>
    db.query("delete from platform.rate_limit_buckets where window_start < now() - interval '1 hour' returning 1"),
  );
  return rows.length;
}
