import "server-only";
import { log } from "@/lib/log";
import { AppError, RateLimitError, UnauthorizedError, ForbiddenError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { withSystem } from "@/lib/db";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { aasaForHost, assetLinksForHost, RESOLVES_PER_ENVIRONMENT_PER_MINUTE } from "./service";

/** The host a request was made to (the well-known files are per host). */
export function requestHost(req: Request): string | null {
  return req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
}

const WELL_KNOWN_HEADERS = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };

/** GET /.well-known/apple-app-site-association: JSON, 200, never a redirect. 404 for hosts with no iOS apps. */
export async function serveAasa(req: Request): Promise<Response> {
  try {
    const aasa = await aasaForHost(requestHost(req));
    if (!aasa.applinks.details.length) return new Response("{}", { status: 404, headers: WELL_KNOWN_HEADERS });
    return new Response(JSON.stringify(aasa), { status: 200, headers: WELL_KNOWN_HEADERS });
  } catch (err) {
    log.error("deep_links.aasa_failed", { error: err });
    return new Response("{}", { status: 503, headers: { ...WELL_KNOWN_HEADERS, "Cache-Control": "no-store", "Retry-After": "30" } });
  }
}

/** GET /.well-known/assetlinks.json: JSON array, 200. 404 for hosts with no Android apps. */
export async function serveAssetLinks(req: Request): Promise<Response> {
  try {
    const statements = await assetLinksForHost(requestHost(req));
    if (!statements.length) return new Response("[]", { status: 404, headers: WELL_KNOWN_HEADERS });
    return new Response(JSON.stringify(statements), { status: 200, headers: WELL_KNOWN_HEADERS });
  } catch (err) {
    log.error("deep_links.assetlinks_failed", { error: err });
    return new Response("[]", { status: 503, headers: { ...WELL_KNOWN_HEADERS, "Cache-Control": "no-store", "Retry-After": "30" } });
  }
}

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

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

/**
 * Wraps the SDK-facing deep link endpoints: public SDK key (or a secret key with
 * events:write), per-environment rate limit, CORS, JSON errors, and one
 * api_request_logs row per authenticated request.
 */
export async function sdkEndpoint(req: Request, route: string, handler: (key: IngestionPrincipal) => Promise<unknown>): Promise<Response> {
  const started = Date.now();
  let principal: IngestionPrincipal | null = null;
  let status = 500;
  let errorCode: string | null = null;
  try {
    const auth = req.headers.get("authorization");
    principal = await authenticateIngestionKey(auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim());
    if (!principal) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
    if (!principal.scopes.includes("events:write")) throw new ForbiddenError("This key doesn't have the events:write permission.");
    const wait = await consumeRateLimit(`dl:${principal.environmentId}`, RESOLVES_PER_ENVIRONMENT_PER_MINUTE, 60);
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
    log.error("deep_links.endpoint_failed", { route, error: err });
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
