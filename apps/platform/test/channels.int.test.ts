/**
 * WhatsApp (Meta Cloud API) and email campaigns (customer's Resend account)
 * against Postgres and a local mock of both APIs: credentials, template sync,
 * template sends with variables, consent and suppression checks, the WhatsApp
 * webhook (verify-token handshake, signature, delivery/read statuses, STOP),
 * sending domains with DNS records, email templates and one-click unsubscribe.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as unsubscribeRoute from "@/app/unsubscribe/[token]/route";
import * as waRoute from "@/app/v1/whatsapp/webhook/[id]/route";
import { withSystem } from "@/lib/db";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { activateAutomation, archiveAutomation, createAutomation, getAutomation } from "@/modules/automation/service";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { deliveryByChannel, sendTestMessage, TEST_SENDS_PER_HOUR } from "@/modules/messaging/delivery";
import { pendingInAppMessages } from "@/modules/messaging/in-app";
import { rateOf } from "@/modules/messaging/metrics";
import { ValidationError } from "@/lib/errors";
import { addEmailDomain, deleteEmailTemplate, getEmailDomain, refreshEmailDomain, saveEmailTemplate } from "@/modules/messaging/email";
import { configureResend, configureWhatsApp, listIntegrations } from "@/modules/messaging/integrations";
import { processPendingEvents } from "@/modules/processing/processor";
import { hubSignature } from "@/modules/whatsapp/messages";
import { listTemplates, syncTemplates } from "@/modules/whatsapp/service";
import { makeTenant } from "./helpers";

process.env.INTEGRATIONS_ENCRYPTION_KEY = "c".repeat(64);
const APP_SECRET = "0123456789abcdef0123456789abcdef";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;
let server: http.Server;
let base: string;
let integrationId: string;
let verifyToken: string;

type Req = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };
const calls: Req[] = [];
const sent = (path: string) => calls.filter((c) => c.path.startsWith(path));
let domainVerified = false;
let wamid = 0;

const send = async (batch: Record<string, unknown>[], principal = sdk, envId = t.dev.id) => {
  const r = await ingest(principal, { batch: batch.map((e) => ({ type: "track", event_id: crypto.randomUUID(), ...e })) }, { mode: "batch" });
  expect((r.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: envId, limit: 1000 });
};
const cycle = async () => {
  await enqueueTriggers();
  await stepRuns();
};
const runsOf = async (id: string) => (await getAutomation(t.ctx, id)).runs.sort((a, b) => a.user_key.localeCompare(b.user_key));
const stepLog = async (id: string, type: string) => (await runsOf(id)).map((r) => `${r.user_key}:${r.log.find((l) => l.type === type)?.outcome}:${r.log.find((l) => l.type === type)?.detail}`);
const NO_GUARDS = { quietHours: null, frequencyCap: null };
const routeCtx = <K extends string>(params: Record<K, string>) => ({ params: Promise.resolve(params) }) as never;

async function webhookPost(body: unknown, secret = APP_SECRET, id = integrationId) {
  const raw = JSON.stringify(body);
  return waRoute.POST(new Request(`http://x/v1/whatsapp/webhook/${id}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": hubSignature(secret, raw) } }), routeCtx({ id }));
}
const statusPayload = (statuses: unknown[], messages: unknown[] = [], phoneNumberId = "1110001") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "2220002", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, statuses, messages } }] }],
});

beforeAll(async () => {
  t = await makeTenant("chan");
  other = await makeTenant("chan-other");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r: Req = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      calls.push(r);
      res.setHeader("Content-Type", "application/json");
      const json = (status: number, v: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(v));
      };
      // Graph API: templates (two pages), messages.
      if (r.path.startsWith("/v23.0/2220002/message_templates")) {
        return json(200, {
          data: [
            { id: "t1", name: "cart_reminder", language: "ar", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "TEXT", text: "طلب {{1}}" }, { type: "BODY", text: "مرحبا {{1}}، سلتك فيها {{2}}" }] },
          ],
          paging: { next: `${base}/templates-page-2` },
        });
      }
      if (r.path === "/templates-page-2") {
        return json(200, { data: [
          { id: "t2", name: "welcome", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Welcome!" }] },
          { id: "t3", name: "promo", language: "en_US", status: "PENDING", category: "MARKETING", components: [{ type: "BODY", text: "Sale {{1}}" }] },
        ] });
      }
      if (r.path === "/v23.0/1110001/messages") {
        if (r.headers.authorization !== "Bearer EAAG-test-access-token-123") return json(401, { error: { code: 190, message: "Invalid OAuth access token" } });
        const to = JSON.parse(body).to as string;
        if (to === "966500000050") return json(400, { error: { code: 131050, message: "Unable to deliver", error_data: { details: "User stopped marketing messages" } } });
        return json(200, { messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.${++wamid}` }] });
      }
      // Resend: domains and emails.
      if (r.method === "POST" && r.path === "/domains") {
        return json(200, { id: "dom_1", name: JSON.parse(body).name, status: "not_started", records: [
          { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "not_started", value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 },
          { record: "DKIM", name: "resend._domainkey", type: "TXT", ttl: "Auto", status: "not_started", value: "p=MIGfMA0GCSqGSIb3DQEB" },
        ] });
      }
      if (r.method === "POST" && r.path === "/domains/dom_1/verify") {
        domainVerified = true;
        return json(200, { object: "domain", id: "dom_1" });
      }
      if (r.method === "GET" && r.path === "/domains/dom_1") {
        const status = domainVerified ? "verified" : "pending";
        return json(200, { id: "dom_1", status, records: [{ record: "SPF", name: "send", type: "MX", status, value: "feedback-smtp.eu-west-1.amazonses.com", priority: 10 }] });
      }
      if (r.path === "/emails") return json(200, { id: `email_${calls.length}` });
      json(404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.WHATSAPP_API_BASE_URL = base;
  process.env.RESEND_API_BASE_URL = base;

  await send([
    { type: "identify", anonymous_id: "a1", user_id: "w1", user_properties: { name: "Sara", phone: "+966 50 123 4567", email: "sara@example.com" } },
    { type: "identify", anonymous_id: "a2", user_id: "w2", user_properties: { name: "Omar", phone: "0501234567" } }, // not E.164
    { type: "identify", anonymous_id: "a3", user_id: "w3", user_properties: { name: "Lina", phone: "+966500000050" } }, // WhatsApp says opted out
    { type: "identify", anonymous_id: "a4", user_id: "w4", user_properties: { name: "Huda", phone: "+971501112222", email: "huda@example.com" } },
    { type: "consent", anonymous_id: "a4", user_id: "w4", consent: { marketing: false } },
  ]);
});

afterAll(async () => {
  delete process.env.WHATSAPP_API_BASE_URL;
  delete process.env.RESEND_API_BASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

describe("WhatsApp", () => {
  it("stores credentials encrypted and shows the verify token once", async () => {
    await expect(configureWhatsApp(t.ctx, t.dev.id, { phoneNumberId: "abc", wabaId: "2220002", accessToken: "x".repeat(30), appSecret: APP_SECRET })).rejects.toThrow(/phone number ID/);
    await expect(configureWhatsApp(t.ctx, t.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: "x".repeat(30), appSecret: "nothex" })).rejects.toThrow(/app secret/);
    const first = await configureWhatsApp(t.ctx, t.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: "EAAG-wrong-token-xxxxxxxx", appSecret: APP_SECRET });
    expect(first.verifyToken).toMatch(/^lavt_/);
    const again = await configureWhatsApp(t.ctx, t.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: "EAAG-test-access-token-123", appSecret: APP_SECRET });
    expect(again).toEqual({ id: first.id, verifyToken: null }); // replacing the token keeps the verify token
    integrationId = first.id;
    verifyToken = first.verifyToken!;
    const row = await withSystem((db) => db.one<{ secret_ciphertext: string; config: object; verify_token_hash: string }>("select secret_ciphertext, config, verify_token_hash from platform.integrations where id = $1", [integrationId]));
    expect(row!.secret_ciphertext).not.toContain("EAAG");
    expect(row!.verify_token_hash).not.toContain(verifyToken);
    expect(row!.config).toEqual({ phone_number_id: "1110001", waba_id: "2220002" });
    const listed = (await listIntegrations(t.ctx, t.dev.id)).find((i) => i.provider === "whatsapp")!;
    expect(JSON.stringify(listed)).not.toContain("EAAG");
    expect(listed.live_verified_at).toBeNull();
  });

  it("answers Meta's verify-token handshake only with the right token", async () => {
    const get = (token: string, id = integrationId) =>
      waRoute.GET(new Request(`http://x/v1/whatsapp/webhook/${id}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`), routeCtx({ id }));
    const ok = await get(verifyToken);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect((await get("lavt_wrong")).status).toBe(403);
    expect((await get(verifyToken, crypto.randomUUID())).status).toBe(403);
  });

  it("syncs templates across pages with their variable counts", async () => {
    expect(await syncTemplates(t.ctx, t.dev.id)).toEqual({ templates: 3, approved: 2 });
    const req = sent("/v23.0/2220002/message_templates")[0];
    expect(req.headers.authorization).toBe("Bearer EAAG-test-access-token-123");
    const list = await listTemplates(t.ctx, t.dev.id);
    expect(list.map((x) => [x.name, x.language, x.status, x.body_params, x.header_params])).toEqual([
      ["cart_reminder", "ar", "APPROVED", 2, 1], ["promo", "en_US", "PENDING", 1, 0], ["welcome", "en_US", "APPROVED", 0, 0],
    ]);
    expect(await listTemplates(other.ctx, other.dev.id)).toEqual([]);
  });

  it("checks template references when saving and activating", async () => {
    const def = (step: Record<string, unknown>) => ({ ...NO_GUARDS, trigger: { type: "event", event: "wa" }, steps: [{ type: "whatsapp", ...step }] });
    await expect(createAutomation(t.ctx, t.dev.id, { name: "Bad", definition: def({ template: "nope", language: "ar" }) })).rejects.toThrow(/isn't synced/);
    await expect(createAutomation(t.ctx, t.dev.id, { name: "Bad", definition: def({ template: "cart_reminder", language: "ar", bodyParams: ["x"] }) })).rejects.toThrow(/needs 2 body and 1 header/);
    const { id } = await createAutomation(t.ctx, t.dev.id, { name: "Pending", definition: def({ template: "promo", language: "en_US", bodyParams: ["20%"] }) });
    await expect(activateAutomation(t.ctx, id)).rejects.toThrow(/not approved/);
  });

  let auto: string;
  it("sends approved templates with variables, skipping people it may not message", async () => {
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "Cart WhatsApp",
      definition: {
        ...NO_GUARDS,
        trigger: { type: "event", event: "checkout_started" },
        steps: [{ type: "whatsapp", template: "cart_reminder", language: "ar", headerParams: ["{{event.order}}"], bodyParams: ["{{user.name}}", "{{event.item}}"] }],
      },
    });
    auto = id;
    await activateAutomation(t.ctx, id);
    await send(["w1", "w2", "w3", "w4"].map((u) => ({ event_name: "checkout_started", user_id: u, properties: { item: "حذاء", order: "A17" } })));
    await cycle();
    expect(await stepLog(id, "whatsapp")).toEqual([
      "w1:done:Sent (template)",
      "w2:skipped:No valid E.164 phone number in the phone user property",
      "w3:failed:WhatsApp 131050: User stopped marketing messages",
      "w4:skipped:Not sent: suppressed",
    ]);
    const msgs = sent("/v23.0/1110001/messages").map((c) => JSON.parse(c.body));
    expect(msgs.find((m) => m.to === "966501234567")).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "966501234567", type: "template",
      template: { name: "cart_reminder", language: { code: "ar" }, components: [
        { type: "header", parameters: [{ type: "text", text: "A17" }] },
        { type: "body", parameters: [{ type: "text", text: "Sara" }, { type: "text", text: "حذاء" }] },
      ] },
    });
    const n = await withSystem((db) => db.query<{ user_key: string; status: string; provider_message_id: string | null; recipient_hash: string | null; payload: object }>(
      "select user_key, status, provider_message_id, recipient_hash, payload from platform.notifications where channel = 'whatsapp' and environment_id = $1 order by user_key", [t.dev.id]));
    expect(n.map((r) => [r.user_key, r.status, r.provider_message_id])).toEqual([["w1", "sent", "wamid.1"], ["w3", "failed", null]]);
    expect(JSON.stringify(n)).not.toContain("966501234567"); // the number itself isn't stored
    // WhatsApp's own opt-out (131050) suppresses the person on WhatsApp.
    const sup = await withSystem((db) => db.query<{ user_key: string; channel: string; source: string }>("select user_key, channel, source from platform.suppressions where environment_id = $1 and source = 'unsubscribe'", [t.dev.id]));
    expect(sup).toEqual([{ user_key: "w3", channel: "whatsapp", source: "unsubscribe" }]);
    // A mock is not the live API.
    expect((await listIntegrations(t.ctx, t.dev.id)).find((i) => i.provider === "whatsapp")!.live_verified_at).toBeNull();
    const usage = await withSystem((db) => db.one<{ q: string }>("select sum(quantity) as q from platform.usage_records where organization_id = $1 and meter_id = 'whatsapp_messages'", [t.org.id]));
    expect(Number(usage!.q)).toBe(1);
  });

  it("applies signed delivery and read receipts, never going backwards", async () => {
    const bad = await webhookPost(statusPayload([{ id: "wamid.1", status: "read", recipient_id: "966501234567" }]), "f".repeat(32));
    expect(bad.status).toBe(401);
    const unsigned = await waRoute.POST(new Request("http://x", { method: "POST", body: "{}" }), routeCtx({ id: integrationId }));
    expect(unsigned.status).toBe(401);

    expect(await (await webhookPost(statusPayload([{ id: "wamid.1", status: "delivered", recipient_id: "966501234567" }]))).json()).toMatchObject({ statuses: 1 });
    await webhookPost(statusPayload([{ id: "wamid.1", status: "read", recipient_id: "966501234567" }]));
    await webhookPost(statusPayload([{ id: "wamid.1", status: "delivered", recipient_id: "966501234567" }])); // late, out of order
    // Another phone number on the same Meta app is ignored.
    await webhookPost(statusPayload([{ id: "wamid.1", status: "failed", errors: [{ code: 1, title: "x" }] }], [], "9999999"));
    const n = await withSystem((db) => db.one<{ status: string; delivered_at: Date | null; read_at: Date | null }>("select status, delivered_at, read_at from platform.notifications where provider_message_id = 'wamid.1'"));
    expect(n!.status).toBe("read");
    expect(n!.delivered_at).not.toBeNull();
    expect(n!.read_at).not.toBeNull();
  });

  it("turns a STOP / إيقاف reply into a WhatsApp suppression", async () => {
    const r = await (await webhookPost(statusPayload([], [{ from: "966501234567", id: "wamid.in1", type: "text", text: { body: "إيقاف" } }]))).json();
    expect(r).toMatchObject({ optOuts: 1 });
    await send([{ event_name: "checkout_started", user_id: "w1", properties: { item: "x", order: "A18" } }]);
    // w1's previous run finished, so a new one starts and is skipped.
    await cycle();
    expect((await runsOf(auto)).filter((x) => x.user_key === "w1").flatMap((x) => x.log).filter((l) => l.type === "whatsapp").map((l) => l.detail)).toContain("Not sent: suppressed");
  });

  it("keeps webhooks to their own environment", async () => {
    const o = await configureWhatsApp(other.ctx, other.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: "EAAG-other-token-xxxxxxxxx", appSecret: "f".repeat(32) });
    // The other tenant's webhook, correctly signed with its own secret, can't touch this tenant's message.
    const res = await webhookPost(statusPayload([{ id: "wamid.1", status: "failed", errors: [{ code: 131050, title: "x" }] }]), "f".repeat(32), o.id);
    expect(await res.json()).toMatchObject({ statuses: 0, optOuts: 0 });
    const n = await withSystem((db) => db.one<{ status: string }>("select status from platform.notifications where provider_message_id = 'wamid.1'"));
    expect(n!.status).toBe("read");
    await archiveAutomation(t.ctx, auto);
  });
});

describe("email campaigns", () => {
  it("adds the sending domain to the customer's Resend account and shows its DNS records", async () => {
    await expect(addEmailDomain(t.ctx, t.dev.id, { name: "mail.shop.example" })).rejects.toThrow(/Connect Resend first/);
    await configureResend(t.ctx, t.dev.id, { apiKey: "re_customer_key_123", from: "Shop <hi@mail.shop.example>" });
    await expect(addEmailDomain(t.ctx, t.dev.id, { name: "https://shop.example/x" })).rejects.toThrow(/Enter a domain/);
    const d = await addEmailDomain(t.ctx, t.dev.id, { name: "Mail.Shop.Example" });
    expect(d.name).toBe("mail.shop.example");
    expect(d.status).toBe("not_started");
    expect(d.records.map((r) => [r.type, r.name])).toEqual([["MX", "send"], ["TXT", "resend._domainkey"]]);
    const create = sent("/domains").find((c) => c.method === "POST")!;
    expect(create.headers.authorization).toBe("Bearer re_customer_key_123");
    expect((await refreshEmailDomain(t.ctx, t.dev.id)).status).toBe("pending");
    expect((await refreshEmailDomain(t.ctx, t.dev.id, { verify: true })).status).toBe("verified");
    expect((await getEmailDomain(t.ctx, t.dev.id))!.status).toBe("verified");
    expect(await getEmailDomain(other.ctx, other.dev.id)).toBeNull();
  });

  it("sends template emails with an unsubscribe link and one-click headers; unsubscribing suppresses email", async () => {
    const templateId = await saveEmailTemplate(t.ctx, t.dev.id, null, { name: "Cart", subject: "Your cart, {{user.name}}", body: "Your {{event.item}} is waiting.\n\nhttps://shop.example/cart" });
    await expect(saveEmailTemplate(t.ctx, t.dev.id, null, { name: "Cart", subject: "x", body: "y" })).rejects.toThrow(/already exists/);
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "Cart email", definition: { ...NO_GUARDS, trigger: { type: "event", event: "cart_email" }, steps: [{ type: "email", templateId }] },
    });
    await expect(deleteEmailTemplate(t.ctx, templateId)).rejects.toThrow(/uses this template/);
    await expect(createAutomation(other.ctx, other.dev.id, { name: "Steal", definition: { ...NO_GUARDS, trigger: { type: "event", event: "x" }, steps: [{ type: "email", templateId }] } })).rejects.toThrow(/doesn't exist/);
    await activateAutomation(t.ctx, id);
    await send([{ event_name: "cart_email", user_id: "w1", properties: { item: "bag" } }, { event_name: "cart_email", user_id: "w4", properties: { item: "hat" } }]);
    await cycle();
    expect(await stepLog(id, "email")).toEqual(["w1:done:Sent", "w4:skipped:Not sent: suppressed"]);

    const email = JSON.parse(sent("/emails").at(-1)!.body);
    expect(email).toMatchObject({ from: "Shop <hi@mail.shop.example>", to: ["sara@example.com"], subject: "Your cart, Sara" });
    expect(email.text).toMatch(/^Your bag is waiting\.\n\nhttps:\/\/shop\.example\/cart\n\n—\nUnsubscribe: http.+\/unsubscribe\/[A-Za-z0-9_-]{32}$/);
    expect(email.html).toContain('<a href="https://shop.example/cart">');
    const url = email.headers["List-Unsubscribe"].slice(1, -1) as string;
    expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(email.text).toContain(url);
    const token = url.split("/unsubscribe/")[1];
    const stored = await withSystem((db) => db.one<{ n: string }>("select count(*) as n from platform.notifications where unsubscribe_token_hash = $1", [token]));
    expect(Number(stored!.n)).toBe(0); // only the hash is stored

    // GET shows a confirmation and changes nothing (link scanners); POST (one-click) unsubscribes.
    const page = await unsubscribeRoute.GET(new Request(url), routeCtx({ token }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post">');
    const emailSupp = () => withSystem((db) => db.query<{ user_key: string; source: string }>("select user_key, source from platform.suppressions where environment_id = $1 and channel = 'email'", [t.dev.id]));
    expect(await emailSupp()).toEqual([]);
    const post = await unsubscribeRoute.POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), routeCtx({ token }));
    expect(post.status).toBe(200);
    expect(await emailSupp()).toEqual([{ user_key: "w1", source: "unsubscribe" }]);
    expect((await unsubscribeRoute.POST(new Request(url, { method: "POST" }), routeCtx({ token }))).status).toBe(200); // idempotent
    expect((await unsubscribeRoute.GET(new Request("http://x"), routeCtx({ token: "x".repeat(32) }))).status).toBe(404);

    await send([{ event_name: "cart_email", user_id: "w1", properties: { item: "bag" } }]);
    await cycle();
    expect((await runsOf(id)).filter((r) => r.user_key === "w1").flatMap((r) => r.log).filter((l) => l.type === "email").map((l) => l.detail)).toContain("Not sent: suppressed");
    await archiveAutomation(t.ctx, id);
    await deleteEmailTemplate(t.ctx, templateId);
  });
});

describe("channels & delivery (PR 11)", () => {
  it("counts what each channel can report, and marks the rest as not available", async () => {
    const d = await deliveryByChannel(t.ctx, t.dev.id, 30);
    // WhatsApp: w1 sent and read (receipts applied above); w3 failed.
    expect(d.whatsapp).toEqual({ sent: 1, failed: 1, delivered: 1, opened: 1, clicked: null });
    // Email: Resend accepted w1's email; no delivery events exist for email yet.
    expect(d.email).toEqual({ sent: 1, failed: 0, delivered: null, opened: null, clicked: null });
    expect(d.push).toEqual({ sent: 0, failed: 0, delivered: null, opened: null, clicked: null });
    expect(d.in_app).toEqual({ sent: 0, failed: 0, delivered: null, opened: 0, clicked: 0 });
    expect(rateOf(d.whatsapp.opened, d.whatsapp.sent)).toBe(1);
    expect(rateOf(d.email.opened, d.email.sent)).toBeNull();
  });

  it("sends tests to one person through the real path, and says exactly what happened", async () => {
    await send([{ type: "identify", anonymous_id: "a5", user_id: "w5", user_properties: { phone: "+966 55 000 0005", email: "nour@example.com" } }]);
    const test = (input: Record<string, unknown>) => sendTestMessage(t.ctx, t.dev.id, input);

    expect(await test({ channel: "email", userId: "w5" })).toEqual({ ok: true, message: "Sent. Resend accepted the email." });
    expect(JSON.parse(sent("/emails").at(-1)!.body)).toMatchObject({ to: ["nour@example.com"], subject: "LeanApp test message" });
    expect(await test({ channel: "email", userId: "w1" })).toEqual({ ok: false, message: "Not sent: this person is on the suppression list." });

    expect(await test({ channel: "whatsapp", userId: "w5", whatsappTemplate: "welcome|en_US" })).toMatchObject({ ok: true });
    expect(sent("/v23.0/1110001/messages").map((c) => JSON.parse(c.body)).at(-1)).toMatchObject({ to: "966550000005", template: { name: "welcome" } });
    expect((await test({ channel: "whatsapp", userId: "w5", whatsappTemplate: "cart_reminder|ar" })).message).toMatch(/needs 2 variables and a header variable/);
    expect((await test({ channel: "whatsapp", userId: "w5", whatsappTemplate: "promo|en_US" })).message).toMatch(/pending, not approved/);
    expect((await test({ channel: "whatsapp", userId: "w2", whatsappTemplate: "welcome|en_US" })).message).toMatch(/no valid E.164 phone number/);

    expect((await test({ channel: "push", userId: "w5" })).message).toMatch(/no active push token/);
    expect((await test({ channel: "in_app", userId: "w5" })).ok).toBe(true);
    const inbox = await pendingInAppMessages(sdk, { userId: "w5" });
    expect(inbox.map((m) => m.title)).toEqual(["LeanApp test message"]);

    await expect(test({ channel: "email", userId: "nobody" })).rejects.toThrow(/No person with the user ID "nobody"/);
    await expect(test({ channel: "sms", userId: "w5" })).rejects.toBeInstanceOf(ValidationError);
    await expect(sendTestMessage({ ...t.ctx, role: "viewer" }, t.dev.id, { channel: "email", userId: "w5" })).rejects.toThrow(/permission/);
    await expect(sendTestMessage(other.ctx, t.dev.id, { channel: "email", userId: "w5" })).rejects.toThrow(/not found/i);

    // Test sends are audited, and never counted as campaign or flow messages.
    const audits = await withSystem((db) => db.query<{ metadata: { channel: string; ok: boolean } }>("select metadata from platform.audit_logs where organization_id = $1 and action = 'message.test_sent' order by created_at", [t.org.id]));
    expect(audits.map((a) => `${a.metadata.channel}:${a.metadata.ok}`)).toContain("email:true");
    const d = await deliveryByChannel(t.ctx, t.dev.id, 30);
    expect([d.email.sent, d.whatsapp.sent, d.in_app.sent]).toEqual([1, 1, 0]);
  });

  it("limits test sends per environment", async () => {
    await withSystem((db) => db.query(
      `insert into platform.notifications (organization_id, environment_id, channel, provider, user_key, status, payload)
       select $1, $2, 'email', 'resend', 'w5', 'sent', '{"test": true}' from generate_series(1, $3)`,
      [t.org.id, t.dev.id, TEST_SENDS_PER_HOUR],
    ));
    await expect(sendTestMessage(t.ctx, t.dev.id, { channel: "in_app", userId: "w5" })).rejects.toThrow(/At most 20 test messages an hour/);
  });
});
