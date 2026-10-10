import "server-only";
import { AppError, ForbiddenError, RateLimitError, UnauthorizedError } from "@/lib/errors";
import { log } from "@/lib/log";
import { consumeRateLimit } from "@/lib/rate-limit";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";

/** Assignment requests per environment per minute (shared by every install of the app). */
const PER_MINUTE = Number(process.env.EXPERIMENT_ASSIGNMENTS_PER_MINUTE ?? 6000);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key",
  "Access-Control-Expose-Headers": "Retry-After",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * The SDK-facing experiment endpoint: public SDK key (or a secret key with
 * events:write), per-environment rate limit, open CORS without cookies, JSON
 * errors, no caching, and one api_request_logs row per authenticated request.
 */
export async function experimentEndpoint(req: Request, route: string, handler: (key: IngestionPrincipal) => Promise<unknown>): Promise<Response> {
  const started = Date.now();
  let principal: IngestionPrincipal | null = null;
  let status = 500;
  let errorCode: string | null = null;
  try {
    const auth = req.headers.get("authorization");
    principal = await authenticateIngestionKey(auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim());
    if (!principal) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
    if (!principal.scopes.includes("events:write")) throw new ForbiddenError("This key doesn't have the events:write permission.");
    const wait = await consumeRateLimit(`exp:${principal.environmentId}`, PER_MINUTE, 60);
    if (wait) throw new RateLimitError(wait);
    const body = await handler(principal);
    status = 200;
    return Response.json(body, { headers: { ...CORS, "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof RateLimitError) {
      status = 429;
      errorCode = err.code;
      return Response.json({ error: err.code, message: err.message }, { status, headers: { ...CORS, "Retry-After": String(err.retryAfterSeconds) } });
    }
    if (err instanceof AppError) {
      status = err.status;
      errorCode = err.code;
      return Response.json({ error: err.code, message: err.message }, { status, headers: CORS });
    }
    log.error("experiments.endpoint_failed", { route, error: err });
    errorCode = "internal_error";
    return Response.json({ error: "internal_error", message: "Unexpected error." }, { status: 500, headers: CORS });
  } finally {
    if (principal) {
      const p = principal;
      await withSystem((db) =>
        db.query(
          "insert into platform.api_request_logs (organization_id, environment_id, route, status_code, duration_ms, credential_kind, error_code) values ($1, $2, $3, $4, $5, $6, $7)",
          [p.organizationId, p.environmentId, `${req.method} ${route}`, status, Date.now() - started, p.kind, errorCode],
        ),
      ).catch((e) => log.error("api_request_log.failed", { error: e }));
    }
  }
}
