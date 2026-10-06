/**
 * Customer webhooks against a local HTTP server: signed deliveries, retries
 * with backoff, giving up, manual retry, audience transition events,
 * secrets encrypted at rest, SSRF rules, permissions and tenant isolation.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { activateAudience, createAudience, recomputeDueAudiences } from "@/modules/audiences/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { createWebhook, deleteWebhook, deliverWebhooks, getWebhook, listWebhooks, retryDelivery, rotateWebhookSecret, sendTestWebhook, updateWebhook } from "@/modules/webhooks/service";
import { verifySignature } from "@/modules/webhooks/signing";
import { makeTenant } from "./helpers";

process.env.INTEGRATIONS_ENCRYPTION_KEY = "e".repeat(64);

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let server: http.Server;
let base: string;
const received: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];
let respond = 200;

beforeAll(async () => {
  t = await makeTenant("hooks");
  other = await makeTenant("hooks-other");
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      res.writeHead(respond, { "Content-Type": "text/plain" });
      res.end(respond === 200 ? "ok" : "nope");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("webhooks", () => {
  let id: string;
  let secret: string;

  it("creates with a one-time secret stored encrypted, never in clear", async () => {
    ({ id, secret } = await createWebhook(t.ctx, t.dev.id, { url: `${base}/hook`, eventTypes: ["audience.entered", "audience.exited"], description: "CRM" }));
    expect(secret).toMatch(/^whsec_/);
    const row = await withSystem((db) => db.one<Record<string, string>>("select * from platform.webhooks where id = $1", [id]));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row!.signing_secret_ciphertext).toMatch(/^v1\./);
    const list = await listWebhooks(t.ctx, t.dev.id);
    expect(list.map((w) => w.secret_prefix)).toEqual([secret.slice(0, 12)]);
    expect(JSON.stringify(list)).not.toContain(secret);
  });

  it("test send delivers a signed request the receiver can verify", async () => {
    received.length = 0;
    const r = await sendTestWebhook(t.ctx, id);
    expect(r).toMatchObject({ status: "succeeded", statusCode: 200 });
    expect(received).toHaveLength(1);
    const { headers, body, path } = received[0];
    expect(path).toBe("/hook");
    expect(headers["leanapp-event"]).toBe("webhook.test");
    expect(headers["leanapp-delivery"]).toBe(r.id);
    expect(headers["idempotency-key"]).toMatch(/^test:/);
    expect(verifySignature(secret, headers["leanapp-signature"] as string, body)).toBe(true);
    expect(verifySignature("whsec_wrong", headers["leanapp-signature"] as string, body)).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ id: r.id, type: "webhook.test" });
  });

  it("retries failures with backoff and gives up after the last attempt", async () => {
    respond = 500;
    const r = await sendTestWebhook(t.ctx, id);
    expect(r).toMatchObject({ status: "pending", statusCode: 500 });
    let row = await withSystem((db) => db.one<{ attempts: number; next_attempt_at: Date; last_error: string }>("select attempts, next_attempt_at, last_error from platform.webhook_deliveries where id = $1", [r.id]));
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe("HTTP 500");
    const wait = (row!.next_attempt_at.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(50);
    expect(wait).toBeLessThan(70);
    // Not due yet: nothing is sent.
    expect(await deliverWebhooks({ ids: [r.id] })).toEqual([]);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await withSystem((db) => db.query("update platform.webhook_deliveries set next_attempt_at = now() where id = $1", [r.id]));
      const [o] = await deliverWebhooks({ ids: [r.id], maxAttempts: 3 });
      expect(o.status).toBe(attempt < 3 ? "pending" : "giving_up");
    }
    row = await withSystem((db) => db.one("select attempts from platform.webhook_deliveries where id = $1", [r.id]));
    expect(row!.attempts).toBe(3);

    // A manual retry from the delivery log tries again immediately.
    respond = 200;
    await retryDelivery(t.ctx, r.id);
    const [o] = await deliverWebhooks({ ids: [r.id] });
    expect(o.status).toBe("succeeded");
    const { deliveries } = await getWebhook(t.ctx, id);
    expect(deliveries.find((d) => d.id === r.id)).toMatchObject({ status: "succeeded", last_status_code: 200 });
  });

  it("never delivers the same delivery twice concurrently", async () => {
    received.length = 0;
    const d = await withSystem(async (db) => {
      const { enqueueDelivery } = await import("@/modules/webhooks/service");
      return enqueueDelivery(db, { organizationId: t.org.id, environmentId: t.dev.id, webhookId: id, eventType: "webhook.test", idempotencyKey: "concurrency", data: {} });
    });
    const [a, b] = await Promise.all([deliverWebhooks({ ids: [d!] }), deliverWebhooks({ ids: [d!] })]);
    expect(a.length + b.length).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("delivers audience transitions to subscribed webhooks", async () => {
    received.length = 0;
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const { id: audienceId } = await createAudience(t.ctx, t.dev.id, { name: "Buyers", definition: { type: "event", event: "purchase" } });
    await activateAudience(t.ctx, audienceId); // baseline: no deliveries
    await ingest(sdk, { batch: [{ type: "track", event_name: "purchase", event_id: crypto.randomUUID(), user_id: "buyer-1" }] }, { mode: "batch" });
    await processPendingEvents({ environmentId: t.dev.id });
    await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [audienceId]));
    await recomputeDueAudiences();
    await deliverWebhooks();
    const bodies = received.map((r) => JSON.parse(r.body));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ type: "audience.entered", data: { audience: { id: audienceId, name: "Buyers" }, user_id: "buyer-1", user_key: "buyer-1", anonymous_id: null } });
    expect(verifySignature(secret, received[0].headers["leanapp-signature"] as string, received[0].body)).toBe(true);
  });

  it("rotates the secret; disabled webhooks don't deliver", async () => {
    const { secret: next } = await rotateWebhookSecret(t.ctx, id);
    expect(next).not.toBe(secret);
    received.length = 0;
    await sendTestWebhook(t.ctx, id);
    expect(verifySignature(next, received[0].headers["leanapp-signature"] as string, received[0].body)).toBe(true);
    await updateWebhook(t.ctx, id, { status: "disabled" });
    expect(await sendTestWebhook(t.ctx, id)).toMatchObject({ status: "failed", error: "webhook_disabled" });
  });

  it("refuses private addresses and plain http on deployments", async () => {
    const prev = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = "production";
    try {
      await expect(createWebhook(t.ctx, t.dev.id, { url: "http://example.com/x", eventTypes: ["audience.entered"] })).rejects.toThrow(/public https/);
      await expect(createWebhook(t.ctx, t.dev.id, { url: "https://169.254.169.254/latest", eventTypes: ["audience.entered"] })).rejects.toThrow(/public https/);
      // A hostname resolving to loopback is refused at connection time.
      const { postJson } = await import("@/modules/webhooks/http");
      const r = await postJson(`http://localhost:${new URL(base).port}/x`, "{}", {});
      expect(r.status).toBeNull();
      expect(r.error).toMatch(/private or reserved/);
    } finally {
      process.env.VERCEL_ENV = prev;
    }
  });

  it("is isolated per tenant and needs webhooks.manage", async () => {
    await expect(getWebhook(other.ctx, id)).rejects.toThrow(/not found/);
    await expect(sendTestWebhook(other.ctx, id)).rejects.toThrow(/not found/);
    await expect(deleteWebhook(other.ctx, id)).rejects.toThrow(/not found/);
    await expect(createWebhook(other.ctx, t.dev.id, { url: `${base}/x`, eventTypes: ["audience.entered"] })).rejects.toThrow(/not found/);
    await expect(listWebhooks({ ...t.ctx, role: "marketer" }, t.dev.id)).rejects.toThrow(/permission/);
    await deleteWebhook(t.ctx, id);
    expect(await listWebhooks(t.ctx, t.dev.id)).toEqual([]);
  });
});
