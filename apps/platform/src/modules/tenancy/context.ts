import "server-only";
import { withSystem, withTenant, type Db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { assertCan } from "@/modules/rbac/authorize";
import type { Permission, Role } from "@/modules/rbac/permissions";

/**
 * The only way request code obtains tenant scope. It is derived from the
 * authenticated user and the organization slug in the URL, and only if a
 * membership row exists. Client-supplied organization ids are never trusted.
 */
export interface TenantContext {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  userId: string;
  role: Role;
}

export async function resolveTenant(userId: string, organizationSlug: string): Promise<TenantContext> {
  const row = await withSystem((db) =>
    db.one<{ id: string; slug: string; name: string; role_id: Role }>(
      `select o.id, o.slug, o.name, m.role_id
         from platform.organizations o
         join platform.organization_members m on m.organization_id = o.id and m.user_id = $1
        where o.slug = $2 and o.status = 'active'`,
      [userId, organizationSlug],
    ),
  );
  // Same error whether the org doesn't exist or the user isn't a member: no tenant enumeration.
  if (!row) throw new NotFoundError("Organization");
  return { organizationId: row.id, organizationSlug: row.slug, organizationName: row.name, userId, role: row.role_id };
}

/** Run `fn` with RLS scoped to the tenant, after checking the permission. */
export async function tenantTx<T>(ctx: TenantContext, permission: Permission, fn: (db: Db) => Promise<T>): Promise<T> {
  assertCan(ctx.role, permission);
  return withTenant({ organizationId: ctx.organizationId, userId: ctx.userId }, fn);
}
