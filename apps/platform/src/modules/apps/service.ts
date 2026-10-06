import "server-only";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { slugify } from "@/lib/slug";
import { audit } from "@/modules/audit/service";
import { insertSdkKey } from "@/modules/credentials/service";
import type { EnvironmentType } from "@/modules/credentials/keys";
import { validTimezone } from "@/modules/organizations/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

export const APP_PLATFORMS = ["android", "ios", "react_native", "flutter", "web", "backend"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];
export const ENVIRONMENT_TYPES: EnvironmentType[] = ["development", "staging", "production"];

export const createAppSchema = z.object({
  name: z.string().trim().min(2, "Enter the app name.").max(80),
  description: z.string().trim().max(500).optional(),
  category: z.string().trim().max(60).optional(),
  platforms: z.array(z.enum(APP_PLATFORMS)).min(1, "Choose at least one platform."),
  timezone: z.string().trim().max(64).refine((tz) => !tz || validTimezone(tz), "Unknown timezone.").optional(),
  defaultCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code.").optional(),
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
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  const data = r.data;
  const slug = slugify(data.name);
  try {
    return await tenantTx(ctx, "apps.create", async (db) => {
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
    if (isUniqueViolation(err)) throw new ConflictError("An app with this name already exists in the organization.");
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
