import "server-only";
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { getUserBySessionToken } from "@/modules/auth/service";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";
import { SESSION_COOKIE } from "./session";

/** Session-authenticated management API helper: resolves the tenant from the session and the org slug. */
export async function apiTenant(req: Request, orgSlug: string): Promise<TenantContext> {
  // Cookie-authenticated writes must be JSON: cross-site forms can't send it without a CORS preflight,
  // which this API never grants. Belt and braces on top of SameSite=Lax.
  if (req.method !== "GET" && req.method !== "HEAD" && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ValidationError("Content-Type must be application/json.");
  }
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const user = await getUserBySessionToken(token ? decodeURIComponent(token) : null);
  if (!user) throw new UnauthorizedError();
  return resolveTenant(user.id, orgSlug);
}

export function apiError(err: unknown): Response {
  if (err instanceof AppError) return Response.json({ error: err.code, message: err.message }, { status: err.status });
  console.error("[api]", err);
  return Response.json({ error: "internal_error", message: "Unexpected error." }, { status: 500 });
}

export { NotFoundError };
