import "server-only";
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
