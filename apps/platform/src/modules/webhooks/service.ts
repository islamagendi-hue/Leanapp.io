import "server-only";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { randomToken, sha256 } from "@/lib/crypto";
import { withSystem, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { decryptSecret, encryptSecret } from "@/lib/secret-box";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { postJson, privateNetworksAllowed } from "./http";
import { backoffSeconds, isPrivateAddress, MAX_ATTEMPTS, signatureHeader, SIGNATURE_HEADER } from "./signing";

/**
 * Customer webhooks: signed HTTP callbacks for engagement events, per
 * environment. Deliveries are queued in webhook_deliveries and sent by
 * deliverWebhooks() (the scheduled worker, and right away for test sends),
 * retried with exponential backoff and given up after MAX_ATTEMPTS.
 * See docs/webhooks.md.
 */
export const WEBHOOK_EVENT_TYPES = ["audience.entered", "audience.exited", "automation.webhook"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number] | "webhook.test";

const urlSchema = z
  .string()
  .trim()
  .max(2000)
  .url("Enter a full URL, e.g. https://example.com/hooks/leanapp.")
  .refine((u) => {
    const url = new URL(u);
    if (url.username || url.password) return false;
    if (privateNetworksAllowed()) return url.protocol === "https:" || url.protocol === "http:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "https:" && !(isIP(host) && isPrivateAddress(host)) && host !== "localhost";
  }, "Use a public https:// URL without credentials.");

const createSchema = z.object({
  url: urlSchema,
  description: z.string().trim().max(200).optional().transform((v) => v || null),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES, "Unknown event type.")).min(1, "Choose at least one event type.").transform((v) => [...new Set(v)]),
});

const updateSchema = z.object({
  url: urlSchema.optional(),
  description: z.string().trim().max(200).optional().transform((v) => v || null),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1, "Choose at least one event type.").optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  return r.data;
}

const aad = (id: string) => `webhook:${id}`;
function newSecret(): string {
  return `whsec_${randomToken(32)}`;
}

export interface WebhookRow {
  id: string;
  environment_id: string;
  url: string;
  description: string | null;
  event_types: string[];
  secret_prefix: string | null;
  status: "active" | "disabled";
  created_at: Date;
  stats?: { pending: number; failed_24h: number; succeeded_24h: number };
}

export interface DeliveryRow {
  id: string;
  event_type: string;
  status: "pending" | "succeeded" | "failed" | "giving_up";
  attempts: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  last_response: string | null;
  last_duration_ms: number | null;
  created_at: Date;
  payload: unknown;
}

async function envRow(db: Db, environmentId: string) {
  const env = await db.one<{ id: string; app_id: string }>("select id, app_id from platform.environments where id = $1", [environmentId]);
  if (!env) throw new NotFoundError("Environment");
  return env;
}

/** Creates a webhook; the signing secret is returned exactly once. */
export async function createWebhook(ctx: TenantContext, environmentId: string, input: unknown): Promise<{ id: string; secret: string }> {
  const data = parse(createSchema, input);
  const id = randomUUID();
  const secret = newSecret();
  const ciphertext = encryptSecret(secret, aad(id)); // throws (fail safe) without INTEGRATIONS_ENCRYPTION_KEY
  return tenantTx(ctx, "webhooks.manage", async (db) => {
    const env = await envRow(db, environmentId);
    await db.query(
      `insert into platform.webhooks (id, organization_id, app_id, environment_id, url, description, event_types, signing_secret_hash, signing_secret_ciphertext, secret_prefix, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, ctx.organizationId, env.app_id, env.id, data.url, data.description, data.eventTypes, sha256(secret), ciphertext, secret.slice(0, 12), ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.created", targetType: "webhook", targetId: id, metadata: { environment_id: env.id, url: data.url, event_types: data.eventTypes } });
    return { id, secret };
  });
}

export async function updateWebhook(ctx: TenantContext, id: string, input: unknown): Promise<void> {
  const data = parse(updateSchema, input);
  await tenantTx(ctx, "webhooks.manage", async (db) => {
    const row = await db.one(
      `update platform.webhooks set url = coalesce($2, url), description = case when $5 then $3 else description end,
              event_types = coalesce($4, event_types), status = coalesce($6, status)
        where id = $1 returning id`,
      [id, data.url ?? null, data.description, data.eventTypes ?? null, "description" in (input as object), data.status ?? null],
    );
    if (!row) throw new NotFoundError("Webhook");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.updated", targetType: "webhook", targetId: id, metadata: { ...data } });
  });
}

export async function rotateWebhookSecret(ctx: TenantContext, id: string): Promise<{ secret: string }> {
  const secret = newSecret();
  const ciphertext = encryptSecret(secret, aad(id));
  return tenantTx(ctx, "webhooks.manage", async (db) => {
    const row = await db.one(
      "update platform.webhooks set signing_secret_hash = $2, signing_secret_ciphertext = $3, secret_prefix = $4 where id = $1 returning id",
      [id, sha256(secret), ciphertext, secret.slice(0, 12)],
    );
    if (!row) throw new NotFoundError("Webhook");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.secret_rotated", targetType: "webhook", targetId: id });
    return { secret };
  });
}

export async function deleteWebhook(ctx: TenantContext, id: string): Promise<void> {
  await tenantTx(ctx, "webhooks.manage", async (db) => {
    const row = await db.one<{ url: string }>("delete from platform.webhooks where id = $1 returning url", [id]);
    if (!row) throw new NotFoundError("Webhook");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "webhook.deleted", targetType: "webhook", targetId: id, metadata: { url: row.url } });
  });
}

const LIST_SQL = `select w.id, w.environment_id, w.url, w.description, w.event_types, w.secret_prefix, w.status, w.created_at,
         json_build_object(
           'pending', (select count(*) from platform.webhook_deliveries d where d.webhook_id = w.id and d.status = 'pending'),
           'failed_24h', (select count(*) from platform.webhook_deliveries d where d.webhook_id = w.id and d.status in ('failed', 'giving_up') and d.created_at > now() - interval '24 hours'),
           'succeeded_24h', (select count(*) from platform.webhook_deliveries d where d.webhook_id = w.id and d.status = 'succeeded' and d.created_at > now() - interval '24 hours')
         ) as stats
    from platform.webhooks w`;

export function listWebhooks(ctx: TenantContext, environmentId: string): Promise<WebhookRow[]> {
  return tenantTx(ctx, "webhooks.manage", (db) => db.query<WebhookRow>(`${LIST_SQL} where w.environment_id = $1 order by w.created_at`, [environmentId]));
}

/** Webhooks an automation can call (id and URL only), for people who edit automations but don't manage webhooks. */
export function listWebhookTargets(ctx: TenantContext, environmentId: string): Promise<{ id: string; url: string; description: string | null; status: string }[]> {
  return tenantTx(ctx, "automations.read", (db) =>
    db.query("select id, url, description, status from platform.webhooks where environment_id = $1 order by created_at", [environmentId]),
  );
}

export async function getWebhook(ctx: TenantContext, id: string, opts: { limit?: number; status?: string } = {}): Promise<{ webhook: WebhookRow; deliveries: DeliveryRow[] }> {
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Webhook");
  return tenantTx(ctx, "webhooks.manage", async (db) => {
    const webhook = await db.one<WebhookRow>(`${LIST_SQL} where w.id = $1`, [id]);
    if (!webhook) throw new NotFoundError("Webhook");
    const status = ["pending", "succeeded", "failed", "giving_up"].includes(opts.status ?? "") ? opts.status : null;
    const deliveries = await db.query<DeliveryRow>(
      `select id, event_type, status, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error, last_response, last_duration_ms, created_at, payload
         from platform.webhook_deliveries where webhook_id = $1 and ($2::text is null or status = $2)
        order by created_at desc limit $3`,
      [id, status, Math.min(opts.limit ?? 50, 200)],
    );
    return { webhook, deliveries };
  });
}

/** Queues a delivery (idempotent per webhook + key) inside the caller's transaction. Returns its id, or null if it already existed. */
export async function enqueueDelivery(
  db: Db,
  d: { organizationId: string; environmentId: string; webhookId: string; eventType: WebhookEventType; idempotencyKey: string; data: unknown; automationRunId?: string | null },
): Promise<string | null> {
  const id = randomUUID();
  const payload = { id, type: d.eventType, created_at: new Date().toISOString(), data: d.data };
  const row = await db.one<{ id: string }>(
    `insert into platform.webhook_deliveries (id, organization_id, webhook_id, environment_id, event_type, idempotency_key, payload, status, next_attempt_at, automation_run_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', now(), $8)
     on conflict (webhook_id, idempotency_key) do nothing returning id`,
    [id, d.organizationId, d.webhookId, d.environmentId, d.eventType, d.idempotencyKey, JSON.stringify(payload), d.automationRunId ?? null],
  );
  return row?.id ?? null;
}

/** Queues audience.entered / audience.exited deliveries for transitions after `afterId` (initial ones excluded). Set-based. */
export async function enqueueAudienceDeliveries(db: Db, audience: { id: string; name: string; environment_id: string }, afterId: string | number): Promise<number> {
  const rows = await db.query(
    `insert into platform.webhook_deliveries (organization_id, webhook_id, environment_id, event_type, idempotency_key, payload, status, next_attempt_at)
     select w.organization_id, w.id, w.environment_id, 'audience.' || ae.kind, 'audience_event:' || ae.id,
            jsonb_build_object('id', gen_random_uuid(), 'type', 'audience.' || ae.kind, 'created_at', ae.occurred_at,
              'data', jsonb_build_object(
                'audience', jsonb_build_object('id', $1::uuid, 'name', $2::text),
                'user_key', ae.user_key,
                'user_id', case when ae.user_key like 'anon:%' then null else ae.user_key end,
                'anonymous_id', case when ae.user_key like 'anon:%' then substr(ae.user_key, 6) end)),
            'pending', now()
       from platform.audience_events ae
       join platform.webhooks w on w.environment_id = $3 and w.status = 'active' and ('audience.' || ae.kind) = any(w.event_types)
      where ae.audience_id = $1 and ae.id > $4 and not ae.initial
     on conflict (webhook_id, idempotency_key) do nothing
     returning 1`,
    [audience.id, audience.name, audience.environment_id, afterId],
  );
  return rows.length;
}

/** Sends a test event to the webhook now and returns the outcome. */
export async function sendTestWebhook(ctx: TenantContext, id: string): Promise<DeliveryOutcome> {
  const deliveryId = await tenantTx(ctx, "webhooks.manage", async (db) => {
    const w = await db.one<{ id: string; environment_id: string }>("select id, environment_id from platform.webhooks where id = $1", [id]);
    if (!w) throw new NotFoundError("Webhook");
    return enqueueDelivery(db, {
      organizationId: ctx.organizationId,
      environmentId: w.environment_id,
      webhookId: w.id,
      eventType: "webhook.test",
      idempotencyKey: `test:${randomUUID()}`,
      data: { message: "Test event from LeanApp. If you can read this, your endpoint works." },
    });
  });
  const [outcome] = await deliverWebhooks({ ids: [deliveryId!] });
  return outcome ?? { id: deliveryId!, status: "pending", statusCode: null, error: "not_attempted" };
}

/** Puts a failed or given-up delivery back in the queue for an immediate attempt. */
export async function retryDelivery(ctx: TenantContext, deliveryId: string): Promise<void> {
  await tenantTx(ctx, "webhooks.manage", async (db) => {
    const row = await db.one(
      "update platform.webhook_deliveries set status = 'pending', next_attempt_at = now(), attempts = 0 where id = $1 and status in ('failed', 'giving_up') returning id",
      [deliveryId],
    );
    if (!row) throw new NotFoundError("Delivery");
  });
}

export interface DeliveryOutcome {
  id: string;
  status: "pending" | "succeeded" | "failed" | "giving_up";
  statusCode: number | null;
  error: string | null;
}

/** A claimed delivery stays invisible to other workers this long (lease). */
const LEASE_SECONDS = 120;

/**
 * Sends due deliveries. Claims a bounded batch with FOR UPDATE SKIP LOCKED and
 * pushes next_attempt_at forward as a lease, so concurrent workers never send
 * the same delivery twice at once; a crashed worker's lease simply expires.
 */
export async function deliverWebhooks(opts: { limit?: number; deadline?: number; ids?: string[]; maxAttempts?: number; concurrency?: number } = {}): Promise<DeliveryOutcome[]> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const claimed = await withSystem((db) =>
    db.query<{
      id: string; webhook_id: string; event_type: string; idempotency_key: string; payload: unknown; attempts: number;
      url: string; ciphertext: string | null; webhook_status: string;
    }>(
      `update platform.webhook_deliveries d set next_attempt_at = now() + make_interval(secs => $3), attempts = d.attempts + 1
         from platform.webhooks w
        where w.id = d.webhook_id and d.id in (
          select id from platform.webhook_deliveries
           where status = 'pending' and next_attempt_at <= now() and ($2::uuid[] is null or id = any($2))
           order by next_attempt_at limit $1 for update skip locked)
        returning d.id, d.webhook_id, d.event_type, d.idempotency_key, d.payload, d.attempts, w.url, w.signing_secret_ciphertext as ciphertext, w.status as webhook_status`,
      [opts.limit ?? 100, opts.ids ?? null, LEASE_SECONDS],
    ),
  );
  const outcomes: DeliveryOutcome[] = [];
  const queue = [...claimed];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      if (opts.deadline && Date.now() >= opts.deadline) {
        // Out of time: release the lease so the next run picks it up, without counting an attempt.
        await withSystem((db) => db.query("update platform.webhook_deliveries set next_attempt_at = now(), attempts = attempts - 1 where id = $1", [d.id]));
        continue;
      }
      outcomes.push(await attempt(d, maxAttempts));
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, Math.max(1, claimed.length)) }, worker));
  return outcomes;
}

async function attempt(
  d: { id: string; webhook_id: string; event_type: string; idempotency_key: string; payload: unknown; attempts: number; url: string; ciphertext: string | null; webhook_status: string },
  maxAttempts: number,
): Promise<DeliveryOutcome> {
  const finish = async (o: { status: DeliveryOutcome["status"]; code: number | null; error: string | null; response?: string; durationMs?: number; retryIn?: number }) => {
    await withSystem((db) =>
      db.query(
        `update platform.webhook_deliveries set status = $2, last_status_code = $3, last_error = $4, last_response = $5, last_duration_ms = $6,
                last_attempt_at = now(), next_attempt_at = case when $2 = 'pending' then now() + make_interval(secs => $7) end,
                succeeded_at = case when $2 = 'succeeded' then now() end
          where id = $1`,
        [d.id, o.status, o.code, o.error, o.response?.slice(0, 500) ?? null, o.durationMs ?? null, o.retryIn ?? 0],
      ),
    );
    return { id: d.id, status: o.status, statusCode: o.code, error: o.error };
  };
  if (d.webhook_status !== "active") return finish({ status: "failed", code: null, error: "webhook_disabled" });
  let secret: string;
  try {
    if (!d.ciphertext) throw new Error("no secret");
    secret = decryptSecret(d.ciphertext, aad(d.webhook_id));
  } catch (err) {
    log.error("webhook.secret_unavailable", { delivery_id: d.id, error: err });
    // Not the endpoint's fault: keep it queued (no attempt counted toward giving up beyond the cap).
    return finish(d.attempts >= maxAttempts ? { status: "giving_up", code: null, error: "secret_unavailable" } : { status: "pending", code: null, error: "secret_unavailable", retryIn: backoffSeconds(d.attempts) });
  }
  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await postJson(d.url, body, {
    [SIGNATURE_HEADER]: signatureHeader(secret, body, timestamp),
    "LeanApp-Event": d.event_type,
    "LeanApp-Delivery": d.id,
    "Idempotency-Key": d.idempotency_key,
  });
  if (res.status !== null && res.status >= 200 && res.status < 300) {
    return finish({ status: "succeeded", code: res.status, error: null, response: res.body, durationMs: res.durationMs });
  }
  const error = res.error ?? `HTTP ${res.status}`;
  if (d.attempts >= maxAttempts) return finish({ status: "giving_up", code: res.status, error, response: res.body, durationMs: res.durationMs });
  return finish({ status: "pending", code: res.status, error, response: res.body, durationMs: res.durationMs, retryIn: backoffSeconds(d.attempts) });
}
