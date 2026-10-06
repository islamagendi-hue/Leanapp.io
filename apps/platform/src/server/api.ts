import "server-only";
import { AppError, ForbiddenError, NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { getUserBySessionToken } from "@/modules/auth/service";
import { authenticateIngestionKey, type ApiKeyScope, type IngestionPrincipal } from "@/modules/credentials/service";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";
import { SESSION_COOKIE } from "./session";
import { log } from "@/lib/log";
import { withSystem } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { envNumber } from "@/lib/env-number";

/**
 * True when the browser says the request came from a page on this origin.
 * Browsers always send Origin on POST and a page can't forge it.
 */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host).split(",")[0].trim();
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Session-authenticated management API helper: resolves the tenant from the session and the org slug.
 * `form: true` admits a plain form POST from the dashboard itself (a file download), checked by origin.
 */
export async function apiTenant(req: Request, orgSlug: string, opts: { form?: boolean } = {}): Promise<TenantContext> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (opts.form) {
      if (!isSameOrigin(req)) throw new ForbiddenError("Cross-site request refused.");
    } else if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      // Cookie-authenticated writes must be JSON: cross-site forms can't send it without a CORS preflight,
      // which this API never grants. Belt and braces on top of SameSite=Lax.
      throw new ValidationError("Content-Type must be application/json.");
    }
  }
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const user = await getUserBySessionToken(token ? decodeURIComponent(token) : null);
  if (!user) throw new UnauthorizedError();
  return resolveTenant(user.id, orgSlug);
}

/**
 * Server-to-server API helper: the caller authenticates with a secret key
 * (`la_sk_…`), which also fixes the organization and environment, and must
 * carry `scope`. Public SDK keys ship inside apps, so they are refused here.
 */
export async function apiSecretKey(req: Request, scope: ApiKeyScope): Promise<IngestionPrincipal> {
  const principal = await authenticateRequestKey(req);
  if (!principal) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
  assertSecretScope(principal, scope);
  return principal;
}

function authenticateRequestKey(req: Request): Promise<IngestionPrincipal | null> {
  const auth = req.headers.get("authorization");
  const raw = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim();
  return authenticateIngestionKey(raw);
}

function assertSecretScope(principal: IngestionPrincipal, scope: ApiKeyScope) {
  if (principal.kind !== "api") throw new ForbiddenError("This endpoint needs a secret API key (la_sk_…), not a public SDK key.");
  if (!principal.scopes.includes(scope)) throw new ForbiddenError(`This key doesn't have the ${scope} permission. Create a secret key with it.`);
}

// An empty value in .env means "default", not 0.
const MANAGEMENT_PER_MINUTE = envNumber("MANAGEMENT_API_REQUESTS_PER_MINUTE", 600);

/**
 * Wraps a management API route (secret key with `scope`): authentication,
 * scope check, a per-environment rate limit, JSON errors, and one row in
 * api_request_logs per authenticated request (including refusals), like ingestion.
 * `route` is the path template that is logged (no ids or user data).
 */
export async function managementApi(
  req: Request,
  route: string,
  scope: ApiKeyScope,
  handler: (key: IngestionPrincipal) => Promise<unknown>,
  opts: { status?: number } = {},
): Promise<Response> {
  const started = Date.now();
  let principal: IngestionPrincipal | null = null;
  let res: Response;
  let errorCode: string | null = null;
  try {
    principal = await authenticateRequestKey(req);
    if (!principal) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
    assertSecretScope(principal, scope);
    const wait = await consumeRateLimit(`mgmt:${principal.environmentId}`, MANAGEMENT_PER_MINUTE, 60);
    if (wait) throw new RateLimitError(wait);
    const body = await handler(principal);
    res = Response.json(body, { status: opts.status ?? 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    errorCode = err instanceof AppError ? err.code : "internal_error";
    res = apiError(err);
  }
  if (principal) {
    const p = principal;
    await withSystem((db) =>
      db.query(
        "insert into platform.api_request_logs (organization_id, environment_id, route, status_code, duration_ms, credential_kind, error_code) values ($1, $2, $3, $4, $5, $6, $7)",
        [p.organizationId, p.environmentId, `${req.method} ${route}`, res.status, Date.now() - started, p.kind, errorCode],
      ),
    ).catch((e) => log.error("api_request_log.failed", { error: e }));
  }
  return res;
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
