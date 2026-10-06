import "server-only";
import { after } from "next/server";
import { withSystem } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { LIMITS } from "./schema";
import { ingest } from "./service";
import { log } from "@/lib/log";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Api-Key",
  "Access-Control-Expose-Headers": "Retry-After, Idempotent-Replayed, X-LeanApp-Plan-Limit",
  "Access-Control-Max-Age": "86400",
};

const PER_MINUTE = Number(process.env.INGEST_EVENTS_PER_MINUTE ?? 6000);

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function credential(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key")?.trim() || null;
}

/**
 * POST /v1/events and /v1/events/batch.
 * Auth → size limits → JSON → rate limit → validate + store → 200, then
 * processing runs after the response is sent.
 */
export async function handleIngest(req: Request, mode: "single" | "batch"): Promise<Response> {
  const started = Date.now();
  const principal = await authenticateIngestionKey(credential(req));
  if (!principal) return json(401, { error: "invalid_api_key", message: "Missing, invalid, revoked or expired key." });
  if (!principal.scopes.includes("events:write")) return json(403, { error: "forbidden", message: "This key doesn't have the events:write permission." });

  let status = 500;
  let errorCode: string | null = null;
  try {
    const max = mode === "batch" ? LIMITS.maxBatchBytes : LIMITS.maxEventBytes;
    if (Number(req.headers.get("content-length") ?? 0) > max) {
      status = 413;
      errorCode = "payload_too_large";
      return json(413, { error: errorCode, message: `Body exceeds ${max} bytes.` });
    }
    const text = await req.text();
    if (text.length > max) {
      status = 413;
      errorCode = "payload_too_large";
      return json(413, { error: errorCode, message: `Body exceeds ${max} bytes.` });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      status = 400;
      errorCode = "invalid_json";
      return json(400, { error: errorCode, message: "Body is not valid JSON." });
    }
    const count = mode === "batch" && Array.isArray((payload as { batch?: unknown[] })?.batch) ? (payload as { batch: unknown[] }).batch.length : 1;
    const wait = await consumeRateLimit(`ingest:${principal.environmentId}`, PER_MINUTE, 60, Math.max(1, count));
    if (wait) {
      status = 429;
      errorCode = "rate_limited";
      return json(429, { error: errorCode, message: "Event rate limit exceeded for this environment." }, { "Retry-After": String(wait) });
    }
    const result = await ingest(principal, payload, { mode, idempotencyKey: req.headers.get("idempotency-key") });
    status = result.status;
    if (status >= 400 && "error" in result.body) errorCode = result.body.error;
    after(() => processPendingEvents({ environmentId: principal.environmentId, limit: 1000 }).catch((e) => log.error("processing.failed", { environment_id: principal.environmentId, error: e })));
    return json(result.status, result.body, { ...result.headers, ...(result.replayed ? { "Idempotent-Replayed": "true" } : {}) });
  } catch (err) {
    log.error("ingest.failed", { environment_id: principal.environmentId, error: err });
    errorCode = "internal_error";
    return json(500, { error: errorCode, message: "Events were not stored. Retry with the same event_id / Idempotency-Key." });
  } finally {
    const duration = Date.now() - started;
    after(() =>
      withSystem((db) =>
        db.query(
          "insert into platform.api_request_logs (organization_id, environment_id, route, status_code, duration_ms, credential_kind, error_code) values ($1, $2, $3, $4, $5, $6, $7)",
          [principal.organizationId, principal.environmentId, mode === "batch" ? "/v1/events/batch" : "/v1/events", status, duration, principal.kind, errorCode],
        ),
      ).catch(() => {}),
    );
  }
}
