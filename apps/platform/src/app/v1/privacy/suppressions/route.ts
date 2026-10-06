import { consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { addSuppression, listSuppressions, removeSuppression, userKeyOf } from "@/modules/privacy/consent";
import type { Requester } from "@/modules/privacy/service";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import { apiError, apiSecretKey, jsonBody } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requester = (key: IngestionPrincipal): Requester => ({ kind: "api_key", organizationId: key.organizationId, environmentId: key.environmentId, keyId: key.keyId });

async function limited(key: IngestionPrincipal) {
  const wait = await consumeRateLimit(`suppressions:${key.environmentId}`, 6000, 3600);
  if (wait) throw new RateLimitError(wait);
}

/** Accepts `channel: "push"` or `channels: ["push", "email"]`. */
function channelsOf(v: { channel?: unknown; channels?: unknown }): unknown {
  if (Array.isArray(v.channels)) return v.channels;
  return typeof v.channel === "string" ? [v.channel] : [];
}

/**
 * GET /v1/privacy/suppressions?channel=&user_id=&anonymous_id=&limit=&cursor= (privacy:read):
 * the key's environment's suppression list, newest first.
 */
export async function GET(req: Request) {
  try {
    const key = await apiSecretKey(req, "privacy:read");
    await limited(key);
    const q = new URL(req.url).searchParams;
    const userKey = userKeyOf({ userId: q.get("user_id")?.trim(), anonymousId: q.get("anonymous_id")?.trim() });
    const { rows, cursor } = await listSuppressions(requester(key), key.environmentId, {
      channel: q.get("channel") ?? undefined,
      userKey: userKey ?? undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
      before: q.get("cursor") ?? undefined,
    });
    return Response.json(
      { data: rows.map((r) => ({ user_key: r.user_key, channel: r.channel, source: r.source, reason: r.reason, created_at: r.created_at })), next_cursor: cursor },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return apiError(err);
  }
}

/** POST /v1/privacy/suppressions {user_id | anonymous_id, channel | channels, reason?} (privacy:write). */
export async function POST(req: Request) {
  try {
    const key = await apiSecretKey(req, "privacy:write");
    await limited(key);
    const body = await jsonBody(req);
    const r = await addSuppression(requester(key), key.environmentId, {
      userId: body.user_id ?? undefined,
      anonymousId: body.anonymous_id ?? undefined,
      channels: channelsOf(body),
      reason: body.reason ?? undefined,
    });
    return Response.json({ user_key: r.userKey, channels: r.channels, suppressed: true }, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * DELETE /v1/privacy/suppressions?user_id=&channel= (privacy:write): removes manual and API entries.
 * Entries from denied consent stay until the user grants consent again; they are listed in `remaining`.
 */
export async function DELETE(req: Request) {
  try {
    const key = await apiSecretKey(req, "privacy:write");
    await limited(key);
    const q = new URL(req.url).searchParams;
    const r = await removeSuppression(requester(key), key.environmentId, {
      userId: q.get("user_id") ?? undefined,
      anonymousId: q.get("anonymous_id") ?? undefined,
      channels: q.getAll("channel"),
    });
    return Response.json({ user_key: r.userKey, removed: r.removed, still_suppressed_by_consent: r.remaining });
  } catch (err) {
    return apiError(err);
  }
}
