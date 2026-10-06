import { authenticateIngestionKey } from "@/modules/credentials/service";
import { consumeRateLimit } from "@/lib/rate-limit";
import { SCHEMA_FETCHES_PER_MINUTE, schemaForKey } from "@/modules/attribution/skan-service";
import { apiError } from "@/server/api";
import { RateLimitError, UnauthorizedError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/skan/conversion-schema (public SDK key): the app's SKAdNetwork /
 * AdAttributionKit conversion value schema for the iOS SDK. The schema holds
 * no secrets; `schema` is null when none is configured.
 */
export async function GET(req: Request) {
  try {
    const auth = req.headers.get("authorization");
    const raw = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key")?.trim();
    const key = await authenticateIngestionKey(raw);
    if (!key) throw new UnauthorizedError("Missing, invalid, revoked or expired key.");
    const wait = await consumeRateLimit(`skan-schema:${key.environmentId}`, SCHEMA_FETCHES_PER_MINUTE, 60);
    if (wait) throw new RateLimitError(wait);
    return Response.json(await schemaForKey(key), { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    return apiError(err);
  }
}
