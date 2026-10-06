import "server-only";
import { RateLimitError, UnauthorizedError } from "@/lib/errors";
import { consumeRateLimit } from "@/lib/rate-limit";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { apiError } from "@/server/api";

/** CORS for the SDK-facing in-app endpoints (public key, any origin, no cookies). */
export const IN_APP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key",
  "Access-Control-Max-Age": "86400",
};

const PER_MINUTE = Number(process.env.IN_APP_REQUESTS_PER_MINUTE ?? 6000);

/** Authenticates the app's public SDK key (or a secret key with events:write) and applies the environment's rate limit. */
export async function inAppPrincipal(req: Request): Promise<IngestionPrincipal> {
  const auth = req.headers.get("authorization");
  const raw = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim();
  const principal = await authenticateIngestionKey(raw);
  if (!principal || !principal.scopes.includes("events:write")) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
  const wait = await consumeRateLimit(`inapp:${principal.environmentId}`, PER_MINUTE, 60);
  if (wait) throw new RateLimitError(wait);
  return principal;
}

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(IN_APP_CORS)) res.headers.set(k, v);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const inAppError = (err: unknown) => withCors(apiError(err));
