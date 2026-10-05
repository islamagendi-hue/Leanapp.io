import { after } from "next/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { apiError, apiSecretKey, jsonBody } from "@/server/api";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * POST /v1/privacy/deletions {user_id?, anonymous_id?} with a secret key.
 * Queues deletion of the subject's data in the key's environment and runs it
 * right after responding; poll GET /v1/privacy/deletions/{id} for the result.
 */
export async function POST(req: Request) {
  try {
    const key = await apiSecretKey(req);
    const wait = await consumeRateLimit(`privacy:${key.environmentId}`, 1000, 3600);
    if (wait) throw new RateLimitError(wait);
    const body = await jsonBody(req);
    const { id, jobId } = await requestDeletion(
      { kind: "api_key", organizationId: key.organizationId, environmentId: key.environmentId, keyId: key.keyId },
      key.environmentId,
      { userId: body.user_id ?? undefined, anonymousId: body.anonymous_id ?? undefined },
    );
    after(() => runDeletionJobs({ jobIds: [jobId] }).catch((e) => log.error("privacy.deletion_failed", { error: e })));
    return Response.json({ id, status: "received" }, { status: 202, headers: { Location: `/v1/privacy/deletions/${id}` } });
  } catch (err) {
    return apiError(err);
  }
}
