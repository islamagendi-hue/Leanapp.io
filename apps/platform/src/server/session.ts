import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { NotFoundError } from "@/lib/errors";
import { getAppBySlug } from "@/modules/apps/service";
import { getUserBySessionToken, type AuthUser } from "@/modules/auth/service";
import { can } from "@/modules/rbac/authorize";
import type { Permission } from "@/modules/rbac/permissions";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";

export const SESSION_COOKIE = "la_session";

export async function setSessionCookie(token: string, expires: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Cached per request. */
export const currentUser = cache(async (): Promise<AuthUser | null> => getUserBySessionToken(await sessionToken()));

export async function requireUser(): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Tenant context for an org slug from the URL; 404 when the user isn't a member. */
export const requireTenant = cache(async (orgSlug: string): Promise<TenantContext> => {
  const user = await requireUser();
  try {
    return await resolveTenant(user.id, orgSlug);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

export async function requestMeta() {
  const h = await headers();
  return {
    userAgent: h.get("user-agent"),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown",
  };
}

/** Page-level permission gate: renders 404 rather than leaking that the page exists. */
export function requirePermission(ctx: TenantContext, permission: Permission) {
  if (!can(ctx.role, permission)) notFound();
}

export const loadApp = cache(async (orgSlug: string, appSlug: string) => {
  const ctx = await requireTenant(orgSlug);
  try {
    return { ctx, ...(await getAppBySlug(ctx, appSlug)) };
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

export function pickEnvironment<E extends { type: string }>(environments: E[], requested: string | string[] | undefined): E {
  const want = typeof requested === "string" ? requested : "development";
  return environments.find((e) => e.type === want) ?? environments[0];
}
