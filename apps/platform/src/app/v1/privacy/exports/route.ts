import { consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { exportSubjectData } from "@/modules/privacy/service";
import { apiError, apiSecretKey, jsonBody } from "@/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

/** POST /v1/privacy/exports {user_id?, anonymous_id?} with a secret key: everything stored about the subject, as JSON. */
export async function POST(req: Request) {
  try {
    const key = await apiSecretKey(req);
    const wait = await consumeRateLimit(`privacy:${key.environmentId}`, 1000, 3600);
    if (wait) throw new RateLimitError(wait);
    const body = await jsonBody(req);
    const data = await exportSubjectData(
      { kind: "api_key", organizationId: key.organizationId, environmentId: key.environmentId, keyId: key.keyId },
      key.environmentId,
      { userId: body.user_id ?? undefined, anonymousId: body.anonymous_id ?? undefined },
    );
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
