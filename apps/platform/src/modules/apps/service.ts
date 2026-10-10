import "server-only";
import { z } from "zod";
import { isUniqueViolation, type Db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { slugify } from "@/lib/slug";
import { audit, type AuditAction } from "@/modules/audit/service";
import { assertCanAddApp } from "@/modules/billing/enforcement";
import { insertSdkKey } from "@/modules/credentials/service";
import { enqueueReprocess } from "@/modules/reprocess/jobs";
import type { EnvironmentType } from "@/modules/credentials/keys";
import { validTimezone } from "@/modules/organizations/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { msg } from "@/i18n/translate";

export const APP_PLATFORMS = ["android", "ios", "react_native", "flutter", "web", "backend"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];
export const ENVIRONMENT_TYPES: EnvironmentType[] = ["development", "staging", "production"];

export const createAppSchema = z.object({
  name: z.string().trim().min(2, msg("Enter the app name.")).max(80),
  description: z.string().trim().max(500).optional(),
  category: z.string().trim().max(60).optional(),
  platforms: z.array(z.enum(APP_PLATFORMS)).min(1, msg("Choose at least one platform.")),
  timezone: z.string().trim().max(64).refine((tz) => !tz || validTimezone(tz), msg("Unknown timezone.")).optional(),
  defaultCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, msg("Use a 3-letter currency code.")).optional(),
});

export interface App {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  timezone: string;
  default_currency: string;
  status: string;
  created_at: Date;
  platforms: AppPlatform[];
}

export interface Environment {
  id: string;
  app_id: string;
  name: string;
  type: EnvironmentType;
  status: string;
}

/**
 * Creates the app with its three isolated environments (each with its own
 * public SDK key) and its Implementation Project, atomically.
 */
export async function createApp(ctx: TenantContext, input: unknown): Promise<{ id: string; slug: string }> {
  const r = createAppSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid input."));
  const data = r.data;
  const slug = slugify(data.name);
  try {
    return await tenantTx(ctx, "apps.create", async (db) => {
      await assertCanAddApp(db, ctx.organizationId);
      const org = await db.one<{ timezone: string; default_currency: string }>(
        "select timezone, default_currency from platform.organizations where id = $1",
        [ctx.organizationId],
      );
      const app = await db.one<{ id: string }>(
        `insert into platform.apps (organization_id, name, slug, description, category, timezone, default_currency)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [ctx.organizationId, data.name, slug, data.description || null, data.category || null,
         data.timezone || org!.timezone, data.defaultCurrency || org!.default_currency],
      );
      const appId = app!.id;
      for (const p of new Set(data.platforms)) {
        await db.query("insert into platform.app_platforms (organization_id, app_id, platform) values ($1, $2, $3)", [ctx.organizationId, appId, p]);
      }
      for (const type of ENVIRONMENT_TYPES) {
        const env = await db.one<{ id: string }>(
          "insert into platform.environments (organization_id, app_id, name, type) values ($1, $2, $3, $4) returning id",
          [ctx.organizationId, appId, type[0].toUpperCase() + type.slice(1), type],
        );
        await insertSdkKey(db, ctx, { id: env!.id, app_id: appId, type }, "Default");
      }
      const project = await db.one<{ id: string }>(
        "insert into platform.tracking_projects (organization_id, app_id) values ($1, $2) returning id",
        [ctx.organizationId, appId],
      );
      await db.query(
        "insert into platform.tracking_plans (organization_id, tracking_project_id, app_id) values ($1, $2, $3)",
        [ctx.organizationId, project!.id, appId],
      );
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "app.created", targetType: "app", targetId: appId, metadata: { platforms: data.platforms } });
      return { id: appId, slug };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(msg("An app with this name already exists in the organization."));
    throw err;
  }
}

const APP_COLUMNS = `a.id, a.name, a.slug, a.description, a.category, a.timezone, a.default_currency, a.status, a.created_at,
  coalesce((select array_agg(p.platform order by p.platform) from platform.app_platforms p where p.app_id = a.id), '{}') as platforms`;

export function listApps(ctx: TenantContext): Promise<App[]> {
  return tenantTx(ctx, "apps.read", (db) =>
    db.query<App>(`select ${APP_COLUMNS} from platform.apps a where a.status = 'active' order by a.created_at`),
  );
}

/** Whether the environment has received any event yet (the Overview's "Connect your app" state). */
export function environmentHasEvents(ctx: TenantContext, environmentId: string): Promise<boolean> {
  return tenantTx(ctx, "apps.read", async (db) => {
    const row = await db.one<{ found: boolean }>("select exists (select 1 from platform.events where environment_id = $1) as found", [environmentId]);
    return !!row?.found;
  });
}

export function getAppBySlug(ctx: TenantContext, slug: string): Promise<{ app: App; environments: Environment[] }> {
  return tenantTx(ctx, "apps.read", async (db) => {
    const app = await db.one<App>(`select ${APP_COLUMNS} from platform.apps a where a.slug = $1`, [slug]);
    if (!app) throw new NotFoundError("App");
    const environments = await db.query<Environment>(
      `select id, app_id, name, type, status from platform.environments where app_id = $1
        order by array_position(array['development','staging','production'], type)`,
      [app.id],
    );
    return { app, environments };
  });
}

// ── Project settings and lifecycle ───────────────────────────────────────────

export const updateAppSchema = z.object({
  name: createAppSchema.shape.name,
  description: createAppSchema.shape.description,
  category: createAppSchema.shape.category,
});

export const appLocaleSchema = z.object({
  timezone: z.string().trim().min(1, msg("Choose a timezone.")).max(64).refine(validTimezone, msg("Unknown timezone.")),
  defaultCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, msg("Use a 3-letter currency code.")),
});

/** Archived projects, for the workspace's project list (restore lives in each one's settings). */
export function listArchivedApps(ctx: TenantContext): Promise<App[]> {
  return tenantTx(ctx, "apps.read", (db) =>
    db.query<App>(`select ${APP_COLUMNS} from platform.apps a where a.status = 'archived' order by a.updated_at desc`),
  );
}

/** Writes the changed columns of one app and audits them as `action`; returns what changed (nothing: a no-op). */
async function changeApp(ctx: TenantContext, appId: string, after: Record<string, string | null>, action: AuditAction, onChange?: (db: Db, changed: string[]) => Promise<void>): Promise<void> {
  const cols = Object.keys(after);
  await tenantTx(ctx, "apps.update", async (db) => {
    const before = await db.one<Record<string, string | null>>(`select ${cols.join(", ")} from platform.apps where id = $1 for update`, [appId]);
    if (!before) throw new NotFoundError("App");
    const changed = cols.filter((k) => after[k] !== before[k]);
    if (!changed.length) return;
    await db.query(
      `update platform.apps set ${changed.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
      [appId, ...changed.map((k) => after[k])],
    );
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action, targetType: "app", targetId: appId,
      metadata: { changed: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])) },
    });
    await onChange?.(db, changed);
  });
}

/** Renames or re-describes a project. The slug, and so every URL and SDK key, stays as it is. */
export async function updateApp(ctx: TenantContext, appId: string, input: unknown): Promise<void> {
  const r = updateAppSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid input."));
  await changeApp(ctx, appId, { name: r.data.name, description: r.data.description || null, category: r.data.category || null }, "app.updated");
}

/** The timezone reports bucket days in and the currency revenue is shown in. Changing them rebuilds Activation. */
export async function updateAppLocale(ctx: TenantContext, appId: string, input: unknown): Promise<void> {
  const r = appLocaleSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? msg("Invalid input."));
  await changeApp(ctx, appId, { timezone: r.data.timezone, default_currency: r.data.defaultCurrency }, "app.locale_updated", async (db, changed) => {
    // Activation's retention days are calendar days in the app's timezone (and revenue
    // falls back to its currency), so growth state is rebuilt when either changes.
    const app = await db.one<{ features: Record<string, unknown> }>("select features from platform.apps where id = $1", [appId]);
    if (app?.features?.growth_model === true) await enqueueReprocess(db, appId, "growth_rebuild", `${changed.join(" and ").replace("default_currency", "currency")} changed`, ctx.userId);
  });
}

/**
 * Archives a project: its SDK keys stop being accepted (credentials only authenticate active apps),
 * it leaves the project list and the plan's app count, and all its data is kept for a restore.
 */
export function archiveApp(ctx: TenantContext, appId: string): Promise<void> {
  return tenantTx(ctx, "apps.delete", async (db) => {
    const app = await db.one<{ status: string }>("select status from platform.apps where id = $1 for update", [appId]);
    if (!app) throw new NotFoundError("App");
    if (app.status === "archived") throw new ConflictError(msg("This project is already archived."));
    await db.query("update platform.apps set status = 'archived' where id = $1", [appId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "app.archived", targetType: "app", targetId: appId });
  });
}

/** Brings an archived project back, if the plan has room for another active app. */
export function restoreApp(ctx: TenantContext, appId: string): Promise<void> {
  return tenantTx(ctx, "apps.delete", async (db) => {
    const app = await db.one<{ status: string }>("select status from platform.apps where id = $1 for update", [appId]);
    if (!app) throw new NotFoundError("App");
    if (app.status !== "archived") throw new ConflictError(msg("This project is not archived."));
    await assertCanAddApp(db, ctx.organizationId);
    await db.query("update platform.apps set status = 'active' where id = $1", [appId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "app.restored", targetType: "app", targetId: appId });
  });
}

/**
 * Pauses or resumes one environment. A paused environment's SDK keys are refused, so it stops
 * receiving events; its data stays. Production can't be paused here: that is what archiving is for.
 */
export function setEnvironmentStatus(ctx: TenantContext, environmentId: string, status: "active" | "disabled"): Promise<void> {
  return tenantTx(ctx, "apps.update", async (db) => {
    const env = await db.one<{ type: EnvironmentType; status: string }>("select type, status from platform.environments where id = $1 for update", [environmentId]);
    if (!env) throw new NotFoundError("Environment");
    if (env.type === "production") throw new ValidationError(msg("Production can't be paused. Archive the project instead."));
    if (env.status === status) return;
    await db.query("update platform.environments set status = $2 where id = $1", [environmentId, status]);
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: status === "active" ? "environment.enabled" : "environment.disabled",
      targetType: "environment", targetId: environmentId, metadata: { type: env.type },
    });
  });
}
