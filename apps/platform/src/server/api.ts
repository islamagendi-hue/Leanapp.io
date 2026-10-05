import "server-only";
import { AppError, ForbiddenError, NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { getUserBySessionToken } from "@/modules/auth/service";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";
import { SESSION_COOKIE } from "./session";
import { log } from "@/lib/log";

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

/**
 * Server-to-server API helper: the caller authenticates with a secret key
 * (`la_sk_…`), which also fixes the organization and environment. Public SDK
 * keys ship inside apps, so they are refused here.
 */
export async function apiSecretKey(req: Request): Promise<IngestionPrincipal> {
  const auth = req.headers.get("authorization");
  const raw = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim();
  const principal = await authenticateIngestionKey(raw);
  if (!principal) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
  if (principal.kind !== "api") throw new ForbiddenError("This endpoint needs a secret API key (la_sk_…), not a public SDK key.");
  return principal;
}

/** Reads a JSON object body; anything else is a 400. */
export async function jsonBody(req: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new ValidationError(`Body exceeds ${maxBytes} bytes.`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ValidationError("Body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be a JSON object.");
  return body as Record<string, unknown>;
}

export function apiError(err: unknown): Response {
  if (err instanceof RateLimitError) {
    return Response.json({ error: err.code, message: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } });
  }
  if (err instanceof AppError) return Response.json({ error: err.code, message: err.message }, { status: err.status });
  log.error("api.failed", { error: err });
  return Response.json({ error: "internal_error", message: "Unexpected error." }, { status: 500 });
}

export { NotFoundError };
