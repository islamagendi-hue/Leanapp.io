/**
 * The automation engine against Postgres and local mock providers: event,
 * audience and schedule triggers; delays, branches, push (FCM + APNs mocks),
 * in-app, email (Resend mock), webhooks, property updates and events; consent,
 * frequency caps, quiet hours, entry rules, versioning, pause/archive,
 * permissions and tenant isolation.
 */
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { activateAudience, createAudience, recomputeDueAudiences } from "@/modules/audiences/service";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { activateAutomation, archiveAutomation, createAutomation, getAutomation, listAutomations, pauseAutomation, updateAutomation } from "@/modules/automation/service";
import { runEngagement } from "@/modules/automation/worker";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { configureApns, configureFcm, configureResend, listIntegrations } from "@/modules/messaging/integrations";
import { processPendingEvents } from "@/modules/processing/processor";
import { resetPushCaches } from "@/modules/push/transport";
import { createWebhook, deliverWebhooks } from "@/modules/webhooks/service";
import { makeTenant } from "./helpers";

process.env.INTEGRATIONS_ENCRYPTION_KEY = "e".repeat(64);

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;
let httpServer: http.Server;
let h2Server: http2.Http2Server;
let base: string;
let webhookId: string;

type Req = { path: string; headers: Record<string, unknown>; body: string };
const calls: { token: Req[]; fcm: Req[]; apns: Req[]; email: Req[]; hook: Req[] } = { token: [], fcm: [], apns: [], email: [], hook: [] };

const send = async (batch: Record<string, unknown>[]) => {
  const r = await ingest(sdk, { batch: batch.map((e) => ({ type: "track", event_id: crypto.randomUUID(), ...e })) }, { mode: "batch" });
  expect((r.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
};
const cycle = async (now?: () => Date) => {
  const triggered = await enqueueTriggers();
  const stepped = await stepRuns({ now });
  return { ...triggered, ...stepped };
};
const makeDue = (automationId: string) => withSystem((db) => db.query("update platform.automation_runs set next_run_at = now() - interval '1 second' where automation_id = $1 and status in ('pending', 'waiting')", [automationId]));
const runsOf = async (automationId: string) => (await getAutomation(t.ctx, automationId)).runs.sort((a, b) => a.user_key.localeCompare(b.user_key));
const NO_GUARDS = { quietHours: null, frequencyCap: null };

async function automation(name: string, definition: Record<string, unknown>, activate = true) {
  const { id } = await createAutomation(t.ctx, t.dev.id, { name, definition: { ...NO_GUARDS, ...definition } });
  if (activate) await activateAutomation(t.ctx, id);
  return id;
}

beforeAll(async () => {
  t = await makeTenant("auto");
  other = await makeTenant("auto-other");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;

  // One HTTP server plays Google OAuth, FCM, Resend and the customer's webhook endpoint.
  httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { path: req.url ?? "", headers: req.headers as Record<string, unknown>, body };
      res.setHeader("Content-Type", "application/json");
      if (r.path === "/token") {
        calls.token.push(r);
        return res.end(JSON.stringify({ access_token: "ya29.mock", expires_in: 3600, token_type: "Bearer" }));
      }
      if (r.path.startsWith("/v1/projects/")) {
        calls.fcm.push(r);
        const token = JSON.parse(body).message.token as string;
        if (token.startsWith("fcm-dead")) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }));
        }
        return res.end(JSON.stringify({ name: "projects/demo-app/messages/1" }));
      }
      if (r.path === "/emails") {
        calls.email.push(r);
        return res.end(JSON.stringify({ id: "email_1" }));
      }
      calls.hook.push(r);
      res.end("{}");
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  // APNs over HTTP/2 (cleartext h2c locally; Apple uses TLS).
  h2Server = http2.createServer();
  h2Server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      calls.apns.push({ path: String(headers[":path"]), headers: headers as Record<string, unknown>, body });
      const dead = String(headers[":path"]).includes("apns-dead");
      stream.respond({ ":status": dead ? 410 : 200, "apns-id": "11111111-2222-3333-4444-555555555555" });
      stream.end(dead ? JSON.stringify({ reason: "Unregistered", timestamp: Date.now() }) : "");
    });
  });
  await new Promise<void>((r) => h2Server.listen(0, "127.0.0.1", r));

  process.env.FCM_API_BASE_URL = base;
  process.env.APNS_BASE_URL = `http://127.0.0.1:${(h2Server.address() as AddressInfo).port}`;
  process.env.RESEND_API_BASE_URL = base;
  resetPushCaches();

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await configureFcm(t.ctx, t.dev.id, {
    serviceAccountJson: JSON.stringify({
      type: "service_account", project_id: "demo-app", client_email: "push@demo-app.iam.gserviceaccount.com",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: `${base}/token`,
    }),
  });
  await configureApns(t.ctx, t.dev.id, { keyId: "ABC123DEFG", teamId: "TEAM123456", bundleId: "com.example.shop", apnsEnvironment: "sandbox", p8: ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  await configureResend(t.ctx, t.dev.id, { apiKey: "re_test_1234567890", from: "Shop <hi@shop.example>" });
  ({ id: webhookId } = await createWebhook(t.ctx, t.dev.id, { url: `${base}/hook`, eventTypes: ["automation.webhook"] }));

  await send([
    { type: "identify", anonymous_id: "a1", user_id: "u1", user_properties: { name: "Sara", email: "sara@example.com" }, context: { platform: "ios" } },
    { type: "push_token", anonymous_id: "a1", user_id: "u1", push_token: { token: "fcm-good-token-1", provider: "fcm", permission: "granted" } },
    { type: "push_token", anonymous_id: "a1", user_id: "u1", push_token: { token: "apns-good-token-1", provider: "apns", permission: "granted" } },
    { type: "identify", anonymous_id: "a2", user_id: "u2", user_properties: { name: "Omar" } },
    { type: "push_token", anonymous_id: "a2", user_id: "u2", push_token: { token: "fcm-dead-token-2", provider: "fcm", permission: "granted" } },
    { type: "identify", anonymous_id: "a3", user_id: "u3", user_properties: { name: "Lina", email: "lina@example.com" } },
    { type: "push_token", anonymous_id: "a3", user_id: "u3", push_token: { token: "fcm-good-token-3", provider: "fcm", permission: "granted" } },
  ]);
  // u3 denies marketing from the SDK's consent screen (automatic marketing suppression).
  await send([{ type: "consent", anonymous_id: "a3", user_id: "u3", consent: { marketing: false } }]);
});

afterAll(async () => {
  resetPushCaches();
  delete process.env.FCM_API_BASE_URL;
  delete process.env.APNS_BASE_URL;
  delete process.env.RESEND_API_BASE_URL;
  await new Promise<void>((r) => httpServer.close(() => r()));
  await new Promise<void>((r) => h2Server.close(() => r()));
});

describe("abandoned checkout flow", () => {
  let id: string;

  it("event trigger → delay → branch → push, in-app, email, webhook, property, event", async () => {
    await send([{ event_name: "checkout_started", user_id: "u1" }]); // before activation: never triggers
    id = await automation("Cart reminder", {
      trigger: { type: "event", event: "checkout_started" },
      steps: [
        { type: "delay", amount: 1, unit: "hours" },
        { type: "branch", condition: { type: "event", event: "purchase", did: false, sinceTrigger: true }, else: "exit" },
        { type: "push", title: "Still thinking, {{user.name}}?", body: "Your {{event.item}} is waiting", deepLink: "shop://cart" },
        { type: "in_app", title: "Your cart", body: "Finish checkout for free delivery", buttonText: "Open cart" },
        { type: "email", subject: "Your cart, {{user.name}}", body: "Come back to finish your order." },
        { type: "webhook", webhookId },
        { type: "update_user_property", property: "cart_reminded", value: true },
        { type: "send_event", event: "cart_reminder_sent", properties: { channel: "push" } },
      ],
    });
    expect((await enqueueTriggers()).runs).toBe(0);

    await send([
      { event_name: "checkout_started", user_id: "u1", properties: { item: "red shoes" } },
      { event_name: "checkout_started", user_id: "u2", properties: { item: "bag" } },
      { event_name: "checkout_started", user_id: "u3", properties: { item: "hat" } },
    ]);
    expect((await cycle()).runs).toBe(3);
    let runs = await runsOf(id);
    expect(runs.map((r) => [r.user_key, r.status, r.current_step])).toEqual([["u1", "waiting", 1], ["u2", "waiting", 1], ["u3", "waiting", 1]]);
    expect(runs[0].next_run_at!.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);

    // Running the triggers again never duplicates runs.
    expect((await enqueueTriggers()).runs).toBe(0);

    // "Since the trigger" starts at the trigger event, not when the worker created the run.
    await withSystem((db) => db.query("update platform.automation_runs set started_at = now() + interval '1 minute' where automation_id = $1", [id]));
    // u2 buys during the delay.
    await send([{ event_name: "purchase", user_id: "u2" }]);
    await makeDue(id);
    await cycle();
    runs = await runsOf(id);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);

    const [u1, u2, u3] = runs;
    expect(u1.log.map((l) => `${l.type}:${l.outcome}`)).toEqual([
      "trigger:started", "delay:waiting", "branch:done", "push:done", "in_app:done", "email:done", "webhook:done", "update_user_property:done", "send_event:done", "run:completed",
    ]);
    expect(u1.log.find((l) => l.type === "push")!.detail).toBe("Sent to 2 of 2 devices");
    expect(u2.log.map((l) => `${l.type}:${l.outcome}`)).toEqual(["trigger:started", "delay:waiting", "branch:exit", "run:completed"]);
    // u3 denied marketing: no push, in-app or email.
    expect(u3.log.filter((l) => ["push", "in_app", "email"].includes(l.type)).map((l) => `${l.type}:${l.outcome}:${l.detail}`)).toEqual([
      "push:skipped:Not sent: suppressed",
      "in_app:skipped:Not sent: suppressed",
      "email:skipped:Not sent: suppressed",
    ]);

    // FCM: OAuth JWT-bearer exchange, then a send with the access token and rendered content.
    expect(calls.token).toHaveLength(1);
    expect(new URLSearchParams(calls.token[0].body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(calls.fcm).toHaveLength(1);
    expect(calls.fcm[0].path).toBe("/v1/projects/demo-app/messages:send");
    expect(calls.fcm[0].headers.authorization).toBe("Bearer ya29.mock");
    expect(JSON.parse(calls.fcm[0].body).message).toMatchObject({
      token: "fcm-good-token-1", notification: { title: "Still thinking, Sara?", body: "Your red shoes is waiting" }, data: { deep_link: "shop://cart", run_id: u1.id },
    });
    // APNs: HTTP/2 with an ES256 provider token and the bundle id as topic.
    expect(calls.apns).toHaveLength(1);
    expect(calls.apns[0].path).toBe("/3/device/apns-good-token-1");
    expect(calls.apns[0].headers).toMatchObject({ "apns-topic": "com.example.shop", "apns-push-type": "alert" });
    expect(String(calls.apns[0].headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // Email through the customer's Resend account to the user's email property.
    expect(calls.email).toHaveLength(1);
    expect(JSON.parse(calls.email[0].body)).toMatchObject({ from: "Shop <hi@shop.example>", to: ["sara@example.com"], subject: "Your cart, Sara" });
    expect(calls.email[0].headers.authorization).toBe("Bearer re_test_1234567890");

    // Webhook delivery queued, then sent by the delivery worker.
    await deliverWebhooks();
    expect(calls.hook).toHaveLength(2); // u1 and u3 (webhooks aren't marketing messages)
    expect(calls.hook.map((h) => JSON.parse(h.body)).find((b) => b.data.user_id === "u1")).toMatchObject({ type: "automation.webhook", data: { run_id: u1.id, trigger: { event: "checkout_started" } } });

    const state = await withSystem(async (db) => ({
      notifications: await db.query<{ channel: string; provider: string; status: string }>(
        "select channel, provider, status from platform.notifications where automation_run_id = $1 order by channel, provider", [u1.id]),
      inApp: await db.query<{ user_key: string; title: string }>("select user_key, title from platform.in_app_messages where automation_id = $1 order by user_key", [id]),
      props: (await db.one<{ properties: Record<string, unknown> }>("select properties from platform.app_users where environment_id = $1 and external_id = 'u1'", [t.dev.id]))!.properties,
      event: await db.one<{ source: string; context: Record<string, unknown> }>("select source, context from platform.events where environment_id = $1 and event_name = 'cart_reminder_sent' and user_id = 'u1'", [t.dev.id]),
      usage: await db.query<{ meter_id: string; quantity: string }>("select meter_id, quantity from platform.usage_records where organization_id = $1 and meter_id in ('automation_runs', 'push_messages') order by meter_id", [t.org.id]),
    }));
    expect(state.notifications).toEqual([
      { channel: "email", provider: "resend", status: "sent" },
      { channel: "push", provider: "apns", status: "sent" },
      { channel: "push", provider: "fcm", status: "sent" },
    ]);
    expect(state.inApp).toEqual([{ user_key: "u1", title: "Your cart" }]);
    expect(state.props).toMatchObject({ cart_reminded: true, name: "Sara" });
    expect(state.event).toMatchObject({ source: "automatic", context: { automation: { id, run_id: u1.id } } });
    expect(state.usage.map((u) => [u.meter_id, Number(u.quantity)])).toEqual([["automation_runs", 3], ["push_messages", 2]]);
  });

  it("events sent by automations never trigger automations (loop protection)", async () => {
    const loop = await automation("Loop", { trigger: { type: "event", event: "cart_reminder_sent" }, steps: [{ type: "send_event", event: "cart_reminder_sent" }] });
    await send([{ event_name: "cart_reminder_sent", user_id: "u9" }]); // a real one does
    await withSystem((db) => db.query("update platform.automations set trigger_cursor = 0 where id = $1", [loop]));
    await cycle();
    await processPendingEvents({ environmentId: t.dev.id });
    await cycle();
    expect((await runsOf(loop)).map((r) => r.user_key)).toEqual(["u9"]);
    await archiveAutomation(t.ctx, loop);
  });

  it("entry rules: one run in progress per person; 'once' never re-enters", async () => {
    const once = await automation("Welcome", { trigger: { type: "event", event: "signed_up" }, entry: { mode: "once" }, steps: [{ type: "delay", amount: 1, unit: "days" }] });
    await send([{ event_name: "signed_up", user_id: "u1" }, { event_name: "signed_up", user_id: "u1" }]);
    await cycle();
    expect(await runsOf(once)).toHaveLength(1);
    await makeDue(once);
    await cycle();
    await send([{ event_name: "signed_up", user_id: "u1" }]);
    await cycle();
    expect((await runsOf(once)).map((r) => r.status)).toEqual(["completed"]);
  });
});

describe("delivery problems and guardrails", () => {
  it("deactivates push tokens the provider reports as dead", async () => {
    const id = await automation("Ping", { trigger: { type: "event", event: "ping" }, steps: [{ type: "push", title: "Hi", body: "Ping" }] });
    await send([{ event_name: "ping", user_id: "u2" }]);
    await cycle();
    const [run] = await runsOf(id);
    expect(run.log.find((l) => l.type === "push")).toMatchObject({ outcome: "failed", detail: "Sent to 0 of 1 device; fcm token invalid (deactivated)" });
    const token = await withSystem((db) => db.one<{ status: string; invalidated_at: Date | null }>("select status, invalidated_at from platform.push_tokens where token = 'fcm-dead-token-2'"));
    expect(token!.status).toBe("invalid");
    expect(token!.invalidated_at).not.toBeNull();
    // Next time there's no token left to try.
    await send([{ event_name: "ping", user_id: "u2" }]);
    await cycle();
    expect((await runsOf(id)).flatMap((r) => r.log).filter((l) => l.type === "push").map((l) => l.outcome)).toContain("skipped");
  });

  it("reports unconnected providers instead of pretending to send", async () => {
    const before = (await listIntegrations(t.ctx, t.dev.id)).map((i) => i.provider).sort();
    expect(before).toEqual(["apns", "fcm", "resend"]);
    const id = await automation("Staging push", { trigger: { type: "event", event: "ping" }, steps: [{ type: "push", title: "Hi", body: "x" }] }, false);
    await withSystem((db) => db.query("delete from platform.integrations where environment_id = $1 and provider = 'fcm'", [t.dev.id]));
    await activateAutomation(t.ctx, id);
    await send([{ event_name: "ping", user_id: "u1" }]);
    await cycle();
    const push = (await runsOf(id))[0].log.find((l) => l.type === "push")!;
    expect(push.detail).toContain("FCM is not connected");
    expect(push.detail).toContain("Sent to 1 of 2 devices"); // APNs still works
    await archiveAutomation(t.ctx, id);
  });

  it("frequency cap counts messages to the person across automations", async () => {
    const id = await automation("Promo", {
      trigger: { type: "event", event: "promo" },
      frequencyCap: { messages: 1, hours: 24 },
      steps: [{ type: "in_app", title: "Sale", body: "20% off" }],
    });
    await send([{ event_name: "promo", user_id: "u4" }]);
    await cycle();
    expect((await runsOf(id))[0].log.find((l) => l.type === "in_app")!.outcome).toBe("done");
    const second = await automation("Promo 2", { trigger: { type: "event", event: "promo2" }, frequencyCap: { messages: 1, hours: 24 }, steps: [{ type: "in_app", title: "Again", body: "x" }] });
    await send([{ event_name: "promo2", user_id: "u4" }]);
    await cycle();
    expect((await runsOf(second))[0].log.find((l) => l.type === "in_app")).toMatchObject({ outcome: "skipped", detail: expect.stringContaining("Frequency cap") });
  });

  it("quiet hours in the organization's timezone hold push until morning", async () => {
    const id = await automation("Night", { trigger: { type: "event", event: "late" }, quietHours: { start: "22:00", end: "08:00" }, steps: [{ type: "push", title: "Hi", body: "Morning!" }] });
    await send([{ event_name: "late", user_id: "u1" }]);
    const night = new Date("2026-01-10T20:30:00Z"); // 23:30 in Riyadh (the org's timezone)
    await cycle(() => night);
    let [run] = await runsOf(id);
    expect(run.status).toBe("waiting");
    expect(run.current_step).toBe(0);
    expect(run.next_run_at!.toISOString()).toBe("2026-01-11T05:00:00.000Z"); // 08:00 Riyadh
    const fcmBefore = calls.apns.length;
    await cycle(() => new Date("2026-01-11T05:00:30Z"));
    [run] = await runsOf(id);
    expect(run.status).toBe("completed");
    expect(calls.apns.length).toBe(fcmBefore + 1);
  });
});

describe("lifecycle", () => {
  let id: string;

  it("versions edits; runs keep the version they started with", async () => {
    id = await automation("Versioned", { trigger: { type: "event", event: "v" }, steps: [{ type: "delay", amount: 1, unit: "hours" }, { type: "in_app", title: "Version 1", body: "x" }] });
    await send([{ event_name: "v", user_id: "u5" }]);
    await cycle();
    const r = await updateAutomation(t.ctx, id, { name: "Versioned", definition: { ...NO_GUARDS, trigger: { type: "event", event: "v" }, steps: [{ type: "delay", amount: 1, unit: "hours" }, { type: "in_app", title: "Version 2", body: "x" }] } });
    expect(r.version).toBe(2);
    await send([{ event_name: "v", user_id: "u6" }]);
    await cycle();
    await makeDue(id);
    await cycle();
    const titles = await withSystem((db) => db.query<{ user_key: string; title: string }>("select user_key, title from platform.in_app_messages where automation_id = $1 order by user_key", [id]));
    expect(titles).toEqual([{ user_key: "u5", title: "Version 1" }, { user_key: "u6", title: "Version 2" }]);
    const detail = await getAutomation(t.ctx, id);
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("pausing holds runs; resuming continues them; archiving cancels them", async () => {
    await send([{ event_name: "v", user_id: "u7" }]);
    await cycle();
    await pauseAutomation(t.ctx, id);
    await makeDue(id);
    expect(await stepRuns()).toEqual({ stepped: 0, failed: 0 });
    expect((await runsOf(id)).find((r) => r.user_key === "u7")!.current_step).toBe(1);
    await send([{ event_name: "v", user_id: "u8" }]); // while paused: not replayed on resume
    await activateAutomation(t.ctx, id);
    await cycle();
    const runs = await runsOf(id);
    expect(runs.find((r) => r.user_key === "u7")!.status).toBe("completed");
    expect(runs.find((r) => r.user_key === "u8")).toBeUndefined();
    await send([{ event_name: "v", user_id: "u9" }]);
    await cycle();
    const { cancelled } = await archiveAutomation(t.ctx, id);
    expect(cancelled).toBe(1);
    expect((await runsOf(id)).find((r) => r.user_key === "u9")!.status).toBe("cancelled");
  });
});

describe("audience and schedule triggers", () => {
  it("starts runs when people enter an audience, and on schedule for its members", async () => {
    const { id: audienceId } = await createAudience(t.ctx, t.dev.id, { name: "VIP", definition: { type: "user_property", property: "vip", op: "eq", value: true } });
    await expect(automation("Too early", { trigger: { type: "audience_entered", audienceId }, steps: [{ type: "in_app", title: "x", body: "y" }] })).rejects.toThrow(/Activate the audience/);
    await activateAudience(t.ctx, audienceId);
    const entered = await automation("VIP welcome", { trigger: { type: "audience_entered", audienceId }, steps: [{ type: "in_app", title: "Welcome, VIP", body: "x" }] });
    const weekly = await automation("VIP weekly", { trigger: { type: "schedule", audienceId, every: "day", at: "09:00" }, steps: [{ type: "in_app", title: "Daily", body: "x" }] });

    await send([{ type: "identify", user_id: "vip-1", user_properties: { vip: true } }]);
    await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [audienceId]));
    await recomputeDueAudiences();
    await cycle();
    expect((await runsOf(entered)).map((r) => [r.user_key, r.status])).toEqual([["vip-1", "completed"]]);

    expect((await runsOf(weekly))).toHaveLength(0);
    await withSystem((db) => db.query("update platform.automations set next_fire_at = now() - interval '1 minute' where id = $1", [weekly]));
    await cycle();
    expect((await runsOf(weekly)).map((r) => r.user_key)).toEqual(["vip-1"]);
    const next = (await getAutomation(t.ctx, weekly)).automation.next_fire_at!;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    // The cron entry point runs the whole pipeline without errors.
    const out = await runEngagement({ deadline: Date.now() + 20_000 });
    expect(out).toHaveProperty("runs");
  });
});

describe("permissions and isolation", () => {
  it("other tenants can't see or reference anything", async () => {
    const [a] = await listAutomations(t.ctx, t.dev.id);
    await expect(getAutomation(other.ctx, a.id)).rejects.toThrow(/not found/);
    await expect(pauseAutomation(other.ctx, a.id)).rejects.toThrow();
    await expect(createAutomation(other.ctx, t.dev.id, { name: "xx", definition: { trigger: { type: "event", event: "x" }, steps: [{ type: "delay", amount: 1, unit: "hours" }] } })).rejects.toThrow(/not found/);
    // Their own automation can't point at our webhook.
    await expect(createAutomation(other.ctx, other.dev.id, { name: "xx", definition: { trigger: { type: "event", event: "x" }, steps: [{ type: "webhook", webhookId }] } })).rejects.toThrow(/webhook/);
    // Another environment of the same app can't use this environment's webhook either.
    const prod = t.environments.find((e) => e.type === "production")!;
    await expect(createAutomation(t.ctx, prod.id, { name: "xx", definition: { trigger: { type: "event", event: "x" }, steps: [{ type: "webhook", webhookId }] } })).rejects.toThrow(/webhook/);
  });

  it("marketers manage; analysts and developers can't see automations", async () => {
    await expect(listAutomations({ ...t.ctx, role: "analyst" }, t.dev.id)).rejects.toThrow(/permission/);
    await expect(listAutomations({ ...t.ctx, role: "developer" }, t.dev.id)).rejects.toThrow(/permission/);
    await expect(createAutomation({ ...t.ctx, role: "marketer" }, t.dev.id, { name: "Marketer's", definition: { trigger: { type: "event", event: "x" }, steps: [{ type: "delay", amount: 1, unit: "hours" }] } })).resolves.toHaveProperty("id");
  });
});
