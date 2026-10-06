import "server-only";
import { listCohorts } from "@/modules/analytics/cohorts";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

/** The environment's cohorts and the requested cohort filter, ignored when it isn't one of them (e.g. deleted). */
export async function cohortFilter(ctx: TenantContext, environmentId: string, requested: string | string[] | undefined) {
  const cohorts = await listCohorts(ctx, environmentId);
  const want = Array.isArray(requested) ? requested[0] : requested;
  const cohort = cohorts.find((c) => c.id === want);
  return { cohorts, cohortId: cohort?.id, cohortName: cohort?.name, missing: Boolean(want) && !cohort, canSave: can(ctx.role, "analytics.write") };
}
