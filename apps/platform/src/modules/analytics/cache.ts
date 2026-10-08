import "server-only";
import { z } from "zod";
import { sha256 } from "@/lib/crypto";
import { log } from "@/lib/log";
import type { TenantContext } from "@/modules/tenancy/context";
import { analyticsTx } from "./service";

/**
 * Short-lived cache of finished report results (platform.report_cache).
 *
 * Postgres stays the source of truth: a cached result is reused for at most
 * REPORT_CACHE_TTL_SECONDS and then computed again from the events. The key
 * hashes everything the result depends on: environment, report kind, the
 * report's input (configuration, range, filters, comparison, interval),
 * timezone, and the audience filter's last change, so editing the audience
 * computes the report again at once. Reading the cache needs analytics.read,
 * like the report itself, and RLS keeps every row inside its organization.
 *
 * The cache never makes a report fail: if reading or writing it fails, the
 * report is computed as if there were no cache.
 */
export const REPORT_CACHE_TTL_SECONDS = 600;
/** Results bigger than this aren't cached (they are rare and cheap to keep out). */
const MAX_BYTES = 512 * 1024;
const VERSION = 1;

export type ReportKind = "trend" | "kpi" | "funnel" | "retention" | "revenue" | "top_events" | "audience_size";

export interface CachedResult<T> {
  value: T;
  /** When the result was computed (now, or when the cached copy was made). */
  computedAt: Date;
  fromCache: boolean;
}

/** JSON with object keys sorted and undefined dropped, so equal inputs give equal keys. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableJson(x))).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
}

export function cacheKey(parts: { environmentId: string; timezone: string; kind: ReportKind; input: unknown; audienceVersion: string | null }): string {
  return sha256(stableJson({ v: VERSION, ...parts }));
}

const audienceId = z.uuid();

/**
 * A report result from the cache when a fresh enough copy exists, otherwise
 * computed by `compute` (which does its own permission checks) and stored.
 * `fresh` skips the cached copy and replaces it.
 */
export async function cachedReport<T>(
  ctx: TenantContext,
  scope: { environmentId: string; timezone: string },
  kind: ReportKind,
  input: Record<string, unknown>,
  compute: () => Promise<T>,
  opts: { fresh?: boolean; ttlSeconds?: number } = {},
): Promise<CachedResult<T>> {
  const ttl = Math.min(Math.max(opts.ttlSeconds ?? REPORT_CACHE_TTL_SECONDS, 60), 900);
  let key: string | null = null;
  try {
    const read = await analyticsTx(ctx, async (db) => {
      const id = typeof input.cohortId === "string" && audienceId.safeParse(input.cohortId).success ? input.cohortId : null;
      const audience = id
        ? await db.one<{ v: string }>("select updated_at::text || status as v from platform.audiences where id = $1 and environment_id = $2", [id, scope.environmentId])
        : null;
      const k = cacheKey({ environmentId: scope.environmentId, timezone: scope.timezone, kind, input, audienceVersion: audience?.v ?? null });
      const hit = opts.fresh
        ? null
        : await db.one<{ result: { value: T }; created_at: Date }>(
            "select result, created_at from platform.report_cache where environment_id = $1 and key = $2 and expires_at > now()",
            [scope.environmentId, k],
          );
      return { key: k, hit };
    });
    if (read.hit) return { value: read.hit.result.value, computedAt: read.hit.created_at, fromCache: true };
    key = read.key;
  } catch (e) {
    // Computed without the cache; a permission error surfaces from compute() as usual.
    log.warn("analytics.cache_read_failed", { kind, error: e });
  }

  const value = await compute();
  const computedAt = new Date();
  if (key) {
    const json = JSON.stringify({ value });
    if (json.length <= MAX_BYTES) {
      await analyticsTx(ctx, (db) =>
        db.query(
          `insert into platform.report_cache (organization_id, environment_id, key, kind, result, expires_at)
           select organization_id, id, $2, $3, $4::jsonb, now() + make_interval(secs => $5::int) from platform.environments where id = $1
           on conflict (environment_id, key) do update set result = excluded.result, kind = excluded.kind, created_at = now(), expires_at = excluded.expires_at`,
          [scope.environmentId, key, kind, json, ttl],
        ),
      ).catch((e) => log.warn("analytics.cache_write_failed", { kind, error: e }));
    }
  }
  return { value, computedAt, fromCache: false };
}
