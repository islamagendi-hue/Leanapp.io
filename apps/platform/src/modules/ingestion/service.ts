import "server-only";
import { randomUUID } from "node:crypto";
import { isUniqueViolation, withSystem } from "@/lib/db";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import { eventAllowance, noteEventsAccepted } from "@/modules/billing/enforcement";
import { retryAfterSeconds } from "@/modules/billing/limits";
import { recordUsage } from "@/modules/usage/service";
import { batchSchema, normalizeEvent, type NormalizedEvent, type NormalizeIssue } from "./schema";

export interface IngestResponse {
  batch_id: string;
  accepted: number;
  duplicates: number;
  rejected: { index: number; event_id?: string; errors: NormalizeIssue[] }[];
  warnings: { index: number; warnings: NormalizeIssue[] }[];
}

export interface IngestResult {
  status: number;
  body: IngestResponse | { error: string; message: string; details?: unknown };
  replayed?: boolean;
  /** Extra response headers (Retry-After on plan_limit_exceeded, the grace marker). */
  headers?: Record<string, string>;
}

/** Response header set while the organization is past its monthly event allowance but inside the grace. */
export const PLAN_GRACE_HEADER = "X-LeanApp-Plan-Limit";

/**
 * Validates, de-duplicates and durably stores events, then returns. All
 * downstream work (identity, sessions, validation against the tracking plan,
 * mapping suggestions) happens asynchronously in modules/processing.
 *
 * Idempotency:
 *   - Per event: unique (environment_id, event_id). Retried events are counted
 *     as duplicates, never stored twice.
 *   - Per request: an Idempotency-Key header stores the response; a retry with
 *     the same key replays it verbatim without touching the event table.
 */
export async function ingest(
  principal: IngestionPrincipal,
  payload: unknown,
  opts: { mode: "single" | "batch"; idempotencyKey?: string | null; now?: Date },
): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const idemKey = opts.idempotencyKey?.trim().slice(0, 200) || null;

  if (idemKey) {
    const prior = await findBatch(principal.environmentId, idemKey);
    if (prior) return { status: 200, body: prior, replayed: true };
  }

  let rawEvents: unknown[];
  let clockSkewMs = 0;
  if (opts.mode === "batch") {
    const parsed = batchSchema.safeParse(payload);
    if (!parsed.success) {
      return { status: 400, body: { error: "invalid_batch", message: "Body must be { batch: [...] } with 1–500 events.", details: parsed.error.issues.slice(0, 5) } };
    }
    rawEvents = parsed.data.batch;
    if (parsed.data.sent_at) {
      const sent = Date.parse(parsed.data.sent_at);
      // Only correct meaningful drift; ignore network latency noise.
      if (!Number.isNaN(sent) && Math.abs(now.getTime() - sent) > 60_000) clockSkewMs = now.getTime() - sent;
    }
  } else {
    rawEvents = [payload];
  }

  // Monthly plan allowance: refused (never silently dropped) once the grace is used up.
  const allowance = await eventAllowance(principal.organizationId, now);
  if (allowance.state === "blocked") {
    await withSystem((db) => recordUsage(db, principal.organizationId, "events_refused", rawEvents.length, now));
    return {
      status: 429,
      body: {
        error: "plan_limit_exceeded",
        message: `This organization has used its monthly event allowance (${allowance.limit} events plus 10% grace). Events are refused until the allowance resets on ${allowance.periodEnd.toISOString().slice(0, 10)} or the plan is upgraded.`,
      },
      headers: { "Retry-After": String(retryAfterSeconds(now)) },
    };
  }
  const graceHeaders = allowance.state === "over" ? { [PLAN_GRACE_HEADER]: "grace" } : undefined;

  const batchId = randomUUID();
  const rejected: IngestResponse["rejected"] = [];
  const warnings: IngestResponse["warnings"] = [];
  const valid: NormalizedEvent[] = [];
  const seen = new Set<string>();
  let inBatchDuplicates = 0;

  rawEvents.forEach((raw, index) => {
    const r = normalizeEvent(raw, {
      now,
      clockSkewMs,
      // Without a client event_id, an Idempotency-Key still makes retries safe.
      fallbackEventId: () => (idemKey ? `${idemKey}:${index}` : randomUUID()),
    });
    if (!r.ok) {
      const eid = (raw as { event_id?: unknown })?.event_id;
      rejected.push({ index, event_id: typeof eid === "string" ? eid : undefined, errors: r.errors });
      return;
    }
    if (r.warnings.length) warnings.push({ index, warnings: r.warnings });
    if (seen.has(r.event.event_id)) {
      inBatchDuplicates++;
      return;
    }
    seen.add(r.event.event_id);
    valid.push(r.event);
  });

  // Backend (secret key) events are attributed to the backend source.
  const source = principal.kind === "api" ? "backend" : "mobile_sdk";

  try {
    const body = await withSystem(async (db) => {
      let accepted = 0;
      if (valid.length) {
        const rows = await db.query<{ event_id: string }>(
          `insert into platform.events
             (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", received_at,
              anonymous_id, user_id, session_id, platform, app_version, os_version, sdk_name, sdk_version,
              source, schema_version, properties, user_properties, context, batch_id)
           select $1, $2, $3, e.event_id, e.type, e.event_name, e.ts, $4,
                  e.anonymous_id, e.user_id, e.session_id, e.platform, e.app_version, e.os_version, e.sdk_name, e.sdk_version,
                  $5, e.schema_version, e.properties, e.user_properties, e.context, $6
             from jsonb_to_recordset($7::jsonb) as e(
                  event_id text, type text, event_name text, ts timestamptz, anonymous_id text, user_id text,
                  session_id text, platform text, app_version text, os_version text, sdk_name text, sdk_version text,
                  schema_version int, properties jsonb, user_properties jsonb, context jsonb)
           on conflict (environment_id, event_id) do nothing
           returning event_id`,
          [principal.organizationId, principal.appId, principal.environmentId, now, source, batchId, JSON.stringify(valid.map((v) => ({ ...v, ts: v.timestamp })))],
        );
        accepted = rows.length;
      }
      const response: IngestResponse = {
        batch_id: batchId,
        accepted,
        duplicates: valid.length - accepted + inBatchDuplicates,
        rejected,
        warnings,
      };
      await db.query(
        `insert into platform.event_batches
           (id, organization_id, app_id, environment_id, idempotency_key, credential_kind,
            received_count, accepted_count, duplicate_count, rejected_count, response, received_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [batchId, principal.organizationId, principal.appId, principal.environmentId, idemKey, principal.kind,
         rawEvents.length, accepted, response.duplicates, rejected.length, JSON.stringify(response), now],
      );
      if (accepted) await recordUsage(db, principal.organizationId, "events", accepted, now);
      return response;
    });
    // 207-style semantics without 207: the batch was processed; per-event errors are in the body.
    if (body.accepted) noteEventsAccepted(principal.organizationId, body.accepted, now);
    const status = opts.mode === "single" && rejected.length ? 400 : 200;
    return { status, body, headers: graceHeaders };
  } catch (err) {
    // Concurrent retry with the same Idempotency-Key: the other request won; replay its response.
    if (idemKey && isUniqueViolation(err)) {
      const prior = await findBatch(principal.environmentId, idemKey);
      if (prior) return { status: 200, body: prior, replayed: true };
    }
    throw err;
  }
}

async function findBatch(environmentId: string, key: string): Promise<IngestResponse | null> {
  const row = await withSystem((db) =>
    db.one<{ response: IngestResponse }>(
      "select response from platform.event_batches where environment_id = $1 and idempotency_key = $2",
      [environmentId, key],
    ),
  );
  return row?.response ?? null;
}
