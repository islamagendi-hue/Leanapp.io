import "server-only";
import type { Db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

/**
 * Per-app feature switches (apps.features), all off by default. Phase 1
 * behaviour is behind them so an app that never turns them on behaves exactly
 * as before:
 *   mapping_history  mapping history with revert, and re-mapping of all past events
 *   growth_model     growth definitions applied to a growth state per person
 */
export const APP_FEATURES = {
  mapping_history: "Mapping history and full re-mapping",
  growth_model: "Growth model",
} as const;
export type AppFeature = keyof typeof APP_FEATURES;

export const isAppFeature = (v: unknown): v is AppFeature => typeof v === "string" && v in APP_FEATURES;

export async function appFeatures(db: Db, appId: string): Promise<Record<AppFeature, boolean>> {
  const row = await db.one<{ features: Record<string, unknown> }>("select features from platform.apps where id = $1", [appId]);
  const f = row?.features ?? {};
  return { mapping_history: f.mapping_history === true, growth_model: f.growth_model === true };
}

export async function featureOn(db: Db, appId: string, feature: AppFeature): Promise<boolean> {
  return (await appFeatures(db, appId))[feature];
}

export function getAppFeatures(ctx: TenantContext, appId: string) {
  return tenantTx(ctx, "apps.read", (db) => appFeatures(db, appId));
}

/**
 * Turns a feature on or off. `onEnable` runs in the same transaction when the
 * feature goes from off to on (e.g. queue the first growth-state build).
 */
export async function setAppFeature(
  ctx: TenantContext,
  appId: string,
  feature: AppFeature,
  on: boolean,
  onEnable?: (db: Db) => Promise<void>,
): Promise<void> {
  return tenantTx(ctx, "apps.update", async (db) => {
    const before = await db.one<{ was: boolean }>("select coalesce((features->>$2)::boolean, false) as was from platform.apps where id = $1 for update", [appId, feature]);
    if (!before) throw new NotFoundError("App");
    if (before.was === on) return;
    await db.query("update platform.apps set features = features || jsonb_build_object($2::text, $3::boolean), updated_at = now() where id = $1", [appId, feature, on]);
    if (on && onEnable) await onEnable(db);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "app.feature_changed", targetType: "app", targetId: appId, metadata: { feature, on } });
  });
}
