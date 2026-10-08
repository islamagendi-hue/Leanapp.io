import "server-only";
import { cachedReport, type ReportKind } from "@/modules/analytics/cache";
import { analyticsTx } from "@/modules/analytics/service";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

/** Audiences that can filter a report: the environment's, except archived ones. Reading them only needs analytics.read. */
export function audienceOptions(ctx: TenantContext, environmentId: string): Promise<{ id: string; name: string }[]> {
  return analyticsTx(ctx, (db) =>
    db.query<{ id: string; name: string }>(
      "select id, name from platform.audiences where environment_id = $1 and status <> 'archived' order by lower(name), id",
      [environmentId],
    ),
  );
}

/**
 * The audience filter of a report page (GET param `cohort`, the name saved
 * reports and old links use), ignored when it isn't one of the options (e.g. archived).
 */
export async function cohortFilter(ctx: TenantContext, environmentId: string, requested: string | string[] | undefined) {
  const cohorts = await audienceOptions(ctx, environmentId);
  const want = Array.isArray(requested) ? requested[0] : requested;
  const cohort = cohorts.find((c) => c.id === want);
  return { cohorts, cohortId: cohort?.id, cohortName: cohort?.name, missing: Boolean(want) && !cohort, canSave: can(ctx.role, "analytics.write") };
}

type Search = Record<string, string | string[] | undefined>;

/**
 * Runs a page's reports through the short-lived result cache
 * (modules/analytics/cache.ts). `?fresh=1` recomputes them. `info` says when
 * the oldest result on the page was computed, for <ReportFreshness>.
 */
export function reportRunner(ctx: TenantContext, scope: { environmentId: string; timezone: string }, sp: Search) {
  const fresh = (Array.isArray(sp.fresh) ? sp.fresh[0] : sp.fresh) === "1";
  const info: FreshnessInfo = { computedAt: null, fromCache: false, ageMinutes: 0 };
  return {
    info,
    async run<T>(kind: ReportKind, input: Record<string, unknown>, compute: () => Promise<T>): Promise<T> {
      const r = await cachedReport(ctx, scope, kind, input, compute, { fresh });
      if (!info.computedAt || r.computedAt < info.computedAt) info.computedAt = r.computedAt;
      info.fromCache ||= r.fromCache;
      info.ageMinutes = Math.max(0, Math.floor((Date.now() - info.computedAt.getTime()) / 60_000));
      return r.value;
    },
  };
}

export interface FreshnessInfo {
  computedAt: Date | null;
  fromCache: boolean;
  /** Age of the oldest result, in whole minutes, when the page was built. */
  ageMinutes: number;
}
