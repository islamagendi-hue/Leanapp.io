import { consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { lookupConsent } from "@/modules/privacy/consent";
import { apiError, apiSecretKey } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /v1/privacy/consent?user_id=&anonymous_id= (privacy:read): the subject's current consent per purpose
 * (true / false / null for no decision), consent history and suppressions in the key's environment.
 * Consent is set with a `consent` event (POST /v1/events), from the SDK or a backend.
 */
export async function GET(req: Request) {
  try {
    const key = await apiSecretKey(req, "privacy:read");
    const wait = await consumeRateLimit(`consent:${key.environmentId}`, 6000, 3600);
    if (wait) throw new RateLimitError(wait);
    const q = new URL(req.url).searchParams;
    const r = await lookupConsent(
      { kind: "api_key", organizationId: key.organizationId, environmentId: key.environmentId, keyId: key.keyId },
      key.environmentId,
      { userId: q.get("user_id") ?? undefined, anonymousId: q.get("anonymous_id") ?? undefined },
    );
    const { updatedAt, ...consent } = r.state;
    return Response.json(
      {
        user_keys: r.keys,
        consent,
        updated_at: updatedAt,
        history: r.history,
        suppressions: r.suppressions.map((s) => ({ user_key: s.user_key, channel: s.channel, source: s.source, reason: s.reason, created_at: s.created_at })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return apiError(err);
  }
}
