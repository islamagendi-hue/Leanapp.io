/**
 * Messaging providers (workstream C): Twilio (SMS, status callbacks, inbound
 * STOP, Content templates), Meta WhatsApp Cloud API connection checks,
 * template discovery with drafts / submit / delete, the 24-hour session
 * window, inbound-message triggers, wait-for-outcome steps, and the campaign
 * composer's check and test send. Every provider call goes to a local mock
 * server (simulated); nothing here talks to Meta or Twilio.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as twilioRoute from "@/app/v1/twilio/webhook/[id]/route";
import * as waRoute from "@/app/v1/whatsapp/webhook/[id]/route";
import { withSystem } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";
import { activateAudience, createAudience, recomputeDueAudiences } from "@/modules/audiences/service";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { activateAutomation, createAutomation, getAutomation } from "@/modules/automation/service";
import { checkCampaign, sendCampaignTest } from "@/modules/campaigns/service";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { jpeg, mp4 } from "@/modules/media/fixtures.test-helper";
import { uploadMedia } from "@/modules/media/service";
import { verifyConnection } from "@/modules/messaging/connections";
import { configureTwilio, configureWhatsApp, listIntegrations } from "@/modules/messaging/integrations";
import { deleteDraft, deleteSyncedTemplate, listDrafts, saveDraft, submitDraft, syncAllTemplates } from "@/modules/messaging/templates";
import { processPendingEvents } from "@/modules/processing/processor";
import { twilioSignature } from "@/modules/twilio/messages";
import { twilioCallbackUrl } from "@/modules/twilio/service";
import { hubSignature } from "@/modules/whatsapp/messages";
import { listTemplates } from "@/modules/whatsapp/service";
import { makeTenant } from "./helpers";

process.env.INTEGRATIONS_ENCRYPTION_KEY = "c".repeat(64);
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const ACCOUNT = `AC${"1".repeat(32)}`;
const TOKEN = "a".repeat(32);
const SERVICE = `MG${"2".repeat(32)}`;
const CONTENT = `HX${"3".repeat(32)}`;
const META_TOKEN = "EAAG-test-access-token-123";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let sdk: IngestionPrincipal;
let server: http.Server;
let base: string;
let twilioId: string;
let waId: string;
let audienceId: string;

type Req = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };
const calls: Req[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path.startsWith(path));
let sid = 0;
let wamid = 0;

const send = async (batch: Record<string, unknown>[]) => {
  const r = await ingest(sdk, { batch: batch.map((e) => ({ type: "track", event_id: crypto.randomUUID(), ...e })) }, { mode: "batch" });
  expect((r.body as { accepted: number }).accepted).toBe(batch.length);
  await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
};
const cycle = async () => {
  await enqueueTriggers();
  await stepRuns();
};
const makeDue = (automationId: string) => withSystem((db) => db.query("update platform.automation_runs set next_run_at = now() - interval '1 second' where automation_id = $1 and status in ('pending', 'waiting')", [automationId]));
const runsOf = async (id: string) => (await getAutomation(t.ctx, id)).runs.sort((a, b) => a.user_key.localeCompare(b.user_key));
const logOf = async (id: string) => (await runsOf(id)).map((r) => `${r.user_key}:${r.log.filter((l) => l.type !== "trigger" && l.type !== "run").map((l) => `${l.type}=${l.outcome}`).join(",")}`);
const NO_GUARDS = { quietHours: null, frequencyCap: null };
const routeCtx = <K extends string>(params: Record<K, string>) => ({ params: Promise.resolve(params) }) as never;

/** A Twilio callback signed the way Twilio signs it (or with a wrong token). */
function twilioPost(params: Record<string, string>, token = TOKEN, id = twilioId) {
  const body = new URLSearchParams(params);
  return twilioRoute.POST(
    new Request(`http://x/v1/twilio/webhook/${id}`, { method: "POST", body: body.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(token, twilioCallbackUrl(id), body) } }),
    routeCtx({ id }),
  );
}
function waInbound(from: string, text: string, id: string) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "2220002", changes: [{ field: "messages", value: { metadata: { phone_number_id: "1110001" }, messages: [{ id, from, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }] } }] }],
  });
  return waRoute.POST(new Request(`http://x/v1/whatsapp/webhook/${waId}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": hubSignature(APP_SECRET, raw) } }), routeCtx({ id: waId }));
}
const smsSid = () => `SM${(++sid).toString(16).padStart(32, "0")}`;
const lastSms = () => Object.fromEntries(new URLSearchParams(callsTo("POST", `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`).at(-1)!.body));

beforeAll(async () => {
  t = await makeTenant("msgp");
  other = await makeTenant("msgp-other");
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
      const basic = `Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString("base64")}`;
      // ── Twilio REST API ──
      if (r.path.startsWith("/2010-04-01/") || r.path.startsWith("/v1/Content")) {
        if (r.headers.authorization !== basic) return json(401, { code: 20003, message: "Authenticate", status: 401 });
        if (r.method === "GET" && r.path === `/2010-04-01/Accounts/${ACCOUNT}.json`) return json(200, { sid: ACCOUNT, status: "active", friendly_name: "Test account" });
        if (r.method === "POST" && r.path === `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`) {
          const to = new URLSearchParams(body).get("To");
          if (to === "+14155550199") return json(400, { code: 21610, message: "Attempt to send to unsubscribed recipient", status: 400 });
          return json(201, { sid: smsSid(), status: "queued" });
        }
        if (r.method === "GET" && r.path.startsWith("/v1/ContentAndApprovals")) {
          return json(200, { contents: [
            { sid: CONTENT, friendly_name: "order_ready", language: "en", variables: { 1: "Sara" }, types: { "twilio/text": { body: "Hi {{1}}, your order is ready." } }, approval_requests: { name: "order_ready", status: "approved", category: "utility" } },
            { sid: `HX${"4".repeat(32)}`, friendly_name: "unsubmitted", language: "en", types: { "twilio/text": { body: "x" } } },
          ], meta: { next_page_url: null } });
        }
        if (r.method === "DELETE" && r.path === `/v1/Content/${CONTENT}`) {
          res.statusCode = 204;
          return res.end();
        }
        return json(404, { code: 20404, message: "not found" });
      }
      // ── Graph API (Meta WhatsApp Cloud API) ──
      if (r.headers.authorization !== `Bearer ${META_TOKEN}`) return json(401, { error: { code: 190, message: "Invalid OAuth access token" } });
      if (r.method === "GET" && r.path.startsWith("/v23.0/1110001?fields=")) return json(200, { id: "1110001", display_phone_number: "+966 11 000 0000", verified_name: "Lean Shop", quality_rating: "GREEN" });
      if (r.method === "GET" && r.path.startsWith("/v23.0/2220002/message_templates")) {
        return json(200, { data: [
          { id: "t1", name: "welcome", language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Welcome {{first_name}}!" }], quality_score: { score: "GREEN" } },
          { id: "t2", name: "photo_offer", language: "ar", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "عرض {{1}}" }] },
          { id: "t3", name: "bad_one", language: "en_US", status: "REJECTED", category: "MARKETING", rejected_reason: "PROMOTIONAL", components: [{ type: "BODY", text: "Buy" }] },
          ...(submitted ? [{ id: "t9", name: "order_update", language: "en_US", status: "PENDING", category: "UTILITY", components: [{ type: "BODY", text: "Order {{1}}" }] }] : []),
        ] });
      }
      if (r.method === "POST" && r.path === "/v23.0/2220002/message_templates") {
        submitted = true;
        return json(200, { id: "t9", status: "PENDING", category: "UTILITY" });
      }
      if (r.method === "DELETE" && r.path.startsWith("/v23.0/2220002/message_templates?")) return json(200, { success: true });
      if (r.method === "POST" && r.path === "/v23.0/1110001/messages") return json(200, { messaging_product: "whatsapp", messages: [{ id: `wamid.${++wamid}` }] });
      json(404, { error: { code: 100, message: "not found" } });
    });
  });
  let submitted = false;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.WHATSAPP_API_BASE_URL = base;
  process.env.TWILIO_API_BASE_URL = base;
  process.env.TWILIO_CONTENT_API_BASE_URL = base;

  await send([
    { type: "identify", anonymous_id: "a1", user_id: "s1", user_properties: { name: "Sam", phone: "+14155550101", vip: true } },
    { type: "identify", anonymous_id: "a2", user_id: "s2", user_properties: { name: "Ann", phone: "+14155550102", vip: true } },
    { type: "identify", anonymous_id: "a3", user_id: "s3", user_properties: { name: "Bob", phone: "+14155550199" } }, // Twilio says unsubscribed
    { type: "identify", anonymous_id: "a4", user_id: "w1", user_properties: { name: "Sara", phone: "+966501234567" } },
  ]);
  audienceId = (await createAudience(t.ctx, t.dev.id, { name: "VIP", definition: { type: "user_property", property: "vip", op: "eq", value: true } })).id;
  await activateAudience(t.ctx, audienceId);
  await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [audienceId]));
  await recomputeDueAudiences();
});

afterAll(async () => {
  delete process.env.WHATSAPP_API_BASE_URL;
  delete process.env.TWILIO_API_BASE_URL;
  delete process.env.TWILIO_CONTENT_API_BASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

describe("connections (simulated against a local mock)", () => {
  it("connects Twilio and checks the connection without claiming live verification", async () => {
    await expect(configureTwilio(t.ctx, t.dev.id, { accountSid: "AC123", authToken: TOKEN, fromNumber: "+14155550000" })).rejects.toThrow(/Account SID/);
    await expect(configureTwilio(t.ctx, t.dev.id, { accountSid: ACCOUNT, authToken: TOKEN })).rejects.toThrow(/Messaging Service SID or a sender/);
    await configureTwilio(t.ctx, t.dev.id, { accountSid: ACCOUNT, authToken: "b".repeat(32), messagingServiceSid: SERVICE, whatsappFrom: "+14155550000" });
    const bad = await verifyConnection(t.ctx, t.dev.id, "twilio");
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/20003/);
    twilioId = await configureTwilio(t.ctx, t.dev.id, { accountSid: ACCOUNT, authToken: TOKEN, messagingServiceSid: SERVICE, whatsappFrom: "+14155550000" });
    const ok = await verifyConnection(t.ctx, t.dev.id, "twilio");
    expect(ok).toEqual({ ok: true, detail: "Twilio account: Test account (local mock, not the live API)" });
    const row = (await listIntegrations(t.ctx, t.dev.id)).find((i) => i.provider === "twilio")!;
    expect(row.config).toMatchObject({ account_sid: ACCOUNT, connection_check: "ok" });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row.live_verified_at).toBeNull();
    // Other tenants and read-only roles can't check it.
    await expect(verifyConnection(other.ctx, t.dev.id, "twilio")).rejects.toThrow();
    await expect(verifyConnection({ ...t.ctx, role: "viewer" }, t.dev.id, "twilio")).rejects.toThrow();
  });

  it("checks the Meta connection and stores the phone number details", async () => {
    waId = (await configureWhatsApp(t.ctx, t.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: META_TOKEN, appSecret: APP_SECRET })).id;
    const r = await verifyConnection(t.ctx, t.dev.id, "whatsapp");
    expect(r).toEqual({ ok: true, detail: "WhatsApp number: Lean Shop · +966 11 000 0000 (local mock, not the live API)" });
    expect(callsTo("GET", "/v23.0/1110001?fields=")[0].path).toContain("verified_name");
  });
});

describe("template discovery", () => {
  it("syncs Meta and Twilio templates with real status, language, category and variables", async () => {
    const r = await syncAllTemplates(t.ctx, t.dev.id);
    expect(r.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([{ provider: "twilio", templates: 2, approved: 1 }, { provider: "whatsapp_cloud", templates: 3, approved: 2 }]);
    const list = await listTemplates(t.ctx, t.dev.id);
    expect(list.map((x) => [x.provider, x.name, x.language, x.status, x.category, x.header_format, x.variables, x.parameter_format])).toEqual([
      ["whatsapp_cloud", "bad_one", "en_US", "REJECTED", "MARKETING", null, [], "POSITIONAL"],
      ["twilio", "order_ready", "en", "APPROVED", "UTILITY", null, ["1"], "POSITIONAL"],
      ["whatsapp_cloud", "photo_offer", "ar", "APPROVED", "MARKETING", "IMAGE", ["1"], "POSITIONAL"],
      ["twilio", "unsubmitted", "en", "UNSUBMITTED", null, null, [], "POSITIONAL"],
      ["whatsapp_cloud", "welcome", "en_US", "APPROVED", "MARKETING", null, ["first_name"], "NAMED"],
    ]);
    expect(list.find((x) => x.name === "bad_one")!.rejected_reason).toBe("PROMOTIONAL");
    expect(list.find((x) => x.name === "welcome")!.quality_score).toBe("GREEN");
    expect(list.find((x) => x.name === "order_ready")!.external_id).toBe(CONTENT);
    expect(await listTemplates(other.ctx, other.dev.id)).toEqual([]);
    await expect(syncAllTemplates(other.ctx, other.dev.id)).rejects.toThrow(/Connect WhatsApp/);
  });

  it("keeps drafts local until submitted, then shows Meta's status", async () => {
    await expect(saveDraft(t.ctx, t.dev.id, null, { name: "Order Update", language: "en_US", category: "UTILITY", body: "x" })).rejects.toThrow(/lowercase/);
    await expect(saveDraft(t.ctx, t.dev.id, null, { name: "order_update", language: "en_US", category: "UTILITY", body: "Order {{2}}", examples: ["1", "2"] })).rejects.toThrow(/\{\{1\}\} is missing/);
    await expect(saveDraft(t.ctx, t.dev.id, null, { name: "order_update", language: "en_US", category: "UTILITY", body: "Order {{1}}" })).rejects.toThrow(/example value/);
    const id = await saveDraft(t.ctx, t.dev.id, null, { name: "order_update", language: "en_US", category: "UTILITY", body: "Order {{1}}", examples: ["A17"] });
    await expect(saveDraft(t.ctx, t.dev.id, null, { name: "order_update", language: "en_US", category: "UTILITY", body: "Order {{1}}", examples: ["A17"] })).rejects.toBeInstanceOf(ConflictError);
    expect((await listTemplates(t.ctx, t.dev.id)).some((x) => x.name === "order_update")).toBe(false);
    expect(callsTo("POST", "/v23.0/2220002/message_templates")).toHaveLength(0);

    expect(await submitDraft(t.ctx, t.dev.id, id)).toEqual({ status: "PENDING" });
    expect(JSON.parse(callsTo("POST", "/v23.0/2220002/message_templates")[0].body)).toEqual({
      name: "order_update", language: "en_US", category: "UTILITY", components: [{ type: "BODY", text: "Order {{1}}", example: { body_text: [["A17"]] } }],
    });
    const [draft] = await listDrafts(t.ctx, t.dev.id);
    expect(draft).toMatchObject({ status: "submitted", external_id: "t9" });
    expect((await listTemplates(t.ctx, t.dev.id)).find((x) => x.name === "order_update")).toMatchObject({ status: "PENDING", provider: "whatsapp_cloud" });
    await expect(submitDraft(t.ctx, t.dev.id, id)).rejects.toBeInstanceOf(ConflictError);
    await expect(saveDraft(t.ctx, t.dev.id, id, { name: "order_update", language: "en_US", category: "UTILITY", body: "Order {{1}}!", examples: ["A17"] })).rejects.toThrow(/submitted draft/);
    await expect(submitDraft({ ...t.ctx, role: "analyst" }, t.dev.id, id)).rejects.toThrow();
    await deleteDraft(t.ctx, id);
    expect(await listDrafts(t.ctx, t.dev.id)).toEqual([]);
  });

  it("deletes synced templates on the provider, but not while a flow uses them", async () => {
    const list = await listTemplates(t.ctx, t.dev.id);
    const welcome = list.find((x) => x.name === "welcome")!;
    const { id } = await createAutomation(t.ctx, t.dev.id, { name: "Uses welcome", definition: { ...NO_GUARDS, trigger: { type: "event", event: "never" }, steps: [{ type: "whatsapp", template: "welcome", language: "en_US", bodyParams: ["{{user.name}}"] }] } });
    await expect(deleteSyncedTemplate(t.ctx, t.dev.id, welcome.id)).rejects.toThrow(/"Uses welcome" uses this template/);
    await withSystem((db) => db.query("update platform.automations set status = 'archived' where id = $1", [id]));

    await deleteSyncedTemplate(t.ctx, t.dev.id, welcome.id);
    expect(callsTo("DELETE", "/v23.0/2220002/message_templates?")[0].path).toBe("/v23.0/2220002/message_templates?name=welcome&hsm_id=t1");
    await deleteSyncedTemplate(t.ctx, t.dev.id, list.find((x) => x.name === "unsubmitted")!.id);
    expect(callsTo("DELETE", "/v1/Content/").map((c) => c.path)).toEqual([`/v1/Content/HX${"4".repeat(32)}`]);
    expect((await listTemplates(t.ctx, t.dev.id)).map((x) => x.name)).not.toContain("welcome");
    await expect(deleteSyncedTemplate(other.ctx, t.dev.id, welcome.id)).rejects.toThrow();
  });
});

describe("SMS through Twilio", () => {
  let auto: string;
  it("sends SMS with the status callback, and skips people Twilio reports as unsubscribed", async () => {
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "SMS hello",
      definition: { ...NO_GUARDS, trigger: { type: "event", event: "sms_hello" }, steps: [{ type: "sms", text: "Hi {{user.name}}" }, { type: "wait_outcome", step: 0, outcome: "delivered", withinHours: 1, else: "exit" }, { type: "update_user_property", property: "got_sms", value: true }] },
    });
    auto = id;
    await activateAutomation(t.ctx, id);
    await send(["s1", "s3"].map((u) => ({ event_name: "sms_hello", user_id: u })));
    await cycle();
    const forms = callsTo("POST", `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`).map((c) => Object.fromEntries(new URLSearchParams(c.body)));
    expect(forms.find((f) => f.To === "+14155550101")).toEqual({ To: "+14155550101", MessagingServiceSid: SERVICE, Body: "Hi Sam", StatusCallback: twilioCallbackUrl(twilioId) });
    expect(await logOf(id)).toEqual(["s1:sms=done,wait_outcome=waiting", "s3:sms=failed,wait_outcome=exit"]);
    const sup = await withSystem((db) => db.query<{ user_key: string; channel: string }>("select user_key, channel from platform.suppressions where environment_id = $1 order by user_key", [t.dev.id]));
    expect(sup).toEqual([{ user_key: "s3", channel: "sms" }]);
    const usage = await withSystem((db) => db.one<{ q: string }>("select sum(quantity) as q from platform.usage_records where organization_id = $1 and meter_id = 'sms_messages'", [t.org.id]));
    expect(Number(usage!.q)).toBe(1);
  });

  it("applies signed status callbacks and continues a wait-for-outcome step", async () => {
    const n = await withSystem((db) => db.one<{ provider_message_id: string }>("select provider_message_id from platform.notifications where environment_id = $1 and channel = 'sms' and user_key = 's1'", [t.dev.id]));
    expect((await twilioPost({ MessageSid: n!.provider_message_id, MessageStatus: "delivered" }, "f".repeat(32))).status).toBe(401);
    expect((await twilioPost({ MessageSid: n!.provider_message_id, MessageStatus: "delivered" })).status).toBe(200);
    const after = await withSystem((db) => db.one<{ status: string; delivered_at: Date | null }>("select status, delivered_at from platform.notifications where provider_message_id = $1", [n!.provider_message_id]));
    expect(after).toMatchObject({ status: "delivered" });
    expect(after!.delivered_at).not.toBeNull();
    await makeDue(auto);
    await stepRuns();
    expect(await logOf(auto)).toEqual(["s1:sms=done,wait_outcome=waiting,wait_outcome=done,update_user_property=done", "s3:sms=failed,wait_outcome=exit"]);
    expect((await twilioPost({ MessageSid: n!.provider_message_id, MessageStatus: "delivered" }, TOKEN, crypto.randomUUID())).status).toBe(404);
  });

  it("starts flows from inbound replies, and turns STOP into an SMS suppression", async () => {
    // s2 has been messaged once, so replies from that number map to the person.
    await send([{ event_name: "sms_hello", user_id: "s2" }]);
    await cycle();
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "JOIN reply", definition: { ...NO_GUARDS, trigger: { type: "inbound_message", channel: "sms", keyword: "join" }, steps: [{ type: "sms", text: "Welcome aboard" }] },
    });
    await activateAutomation(t.ctx, id);
    expect((await twilioPost({ MessageSid: smsSid(), From: "+14155550101", To: "+14155550000", Body: " JOIN " })).status).toBe(200);
    expect((await twilioPost({ MessageSid: smsSid(), From: "+14155550102", To: "+14155550000", Body: "hello" })).status).toBe(200);
    expect((await twilioPost({ MessageSid: smsSid(), From: "+14155550102", To: "+14155550000", Body: "STOP", OptOutType: "STOP" })).status).toBe(200);
    // A duplicate delivery of the same message is stored once.
    const dup = smsSid();
    await twilioPost({ MessageSid: dup, From: "+14155559876", To: "+14155550000", Body: "hi" });
    await twilioPost({ MessageSid: dup, From: "+14155559876", To: "+14155550000", Body: "hi" });
    await cycle();
    expect(await logOf(id)).toEqual(["s1:sms=done"]);
    expect(lastSms()).toMatchObject({ To: "+14155550101", Body: "Welcome aboard" });
    const inbound = await withSystem((db) => db.query<{ user_key: string | null; opt_out: boolean; body: string }>("select user_key, opt_out, body from platform.inbound_messages where environment_id = $1 order by id", [t.dev.id]));
    expect(inbound).toEqual([
      { user_key: "s1", opt_out: false, body: " JOIN " }, { user_key: "s2", opt_out: false, body: "hello" }, { user_key: "s2", opt_out: true, body: "STOP" }, { user_key: null, opt_out: false, body: "hi" },
    ]);
    const sup = await withSystem((db) => db.query<{ user_key: string; channel: string }>("select user_key, channel from platform.suppressions where environment_id = $1 order by user_key", [t.dev.id]));
    expect(sup).toEqual([{ user_key: "s2", channel: "sms" }, { user_key: "s3", channel: "sms" }]);
    // No phone number is stored in clear.
    const raw = await withSystem((db) => db.query("select * from platform.inbound_messages where environment_id = $1", [t.dev.id]));
    expect(JSON.stringify(raw)).not.toContain("14155550102");
  });
});

describe("WhatsApp session messages", () => {
  it("sends free-form messages only inside the 24-hour window", async () => {
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "WA session", definition: { ...NO_GUARDS, entry: { mode: "every_time", cooldownHours: 0 }, trigger: { type: "event", event: "wa_reply" }, steps: [{ type: "whatsapp_session", text: "Thanks {{user.name}}" }] },
    });
    await activateAutomation(t.ctx, id);
    await send([{ event_name: "wa_reply", user_id: "w1" }]);
    await cycle();
    expect((await runsOf(id))[0].log.find((l) => l.type === "whatsapp_session")).toMatchObject({ outcome: "skipped", detail: expect.stringMatching(/24-hour window/) });
    expect(callsTo("POST", "/v23.0/1110001/messages")).toHaveLength(0);

    expect((await waInbound("966501234567", "Hi", "wamid.in1")).status).toBe(200);
    await send([{ event_name: "wa_reply", user_id: "w1" }]);
    await cycle();
    const sent = callsTo("POST", "/v23.0/1110001/messages");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "966501234567", type: "text", text: { preview_url: false, body: "Thanks Sara" } });
    // The window closes 24 hours after the last inbound message.
    await withSystem((db) => db.query("update platform.messaging_sessions set last_inbound_at = now() - interval '25 hours' where environment_id = $1 and channel = 'whatsapp'", [t.dev.id]));
    await send([{ event_name: "wa_reply", user_id: "w1" }]);
    await cycle();
    expect(callsTo("POST", "/v23.0/1110001/messages")).toHaveLength(1);
  });

  it("attaches media library files to WhatsApp headers and MMS, and refuses files that don't fit", async () => {
    // A media-header template needs a media file even in a draft…
    await expect(createAutomation(t.ctx, t.dev.id, {
      name: "Photo", definition: { ...NO_GUARDS, trigger: { type: "event", event: "photo" }, steps: [{ type: "whatsapp", template: "photo_offer", language: "ar", bodyParams: ["20%"] }] },
    })).rejects.toThrow(/media header \(IMAGE\)/);
    // …and the file must be in this app's library.
    await expect(createAutomation(t.ctx, t.dev.id, {
      name: "Photo 2", definition: { ...NO_GUARDS, trigger: { type: "event", event: "photo" }, steps: [{ type: "whatsapp", template: "photo_offer", language: "ar", bodyParams: ["20%"], mediaAssetId: crypto.randomUUID() }] },
    })).rejects.toThrow(/not in this app's library/);
    // A video can't go in an IMAGE header.
    const video = (await uploadMedia(t.ctx, t.app.id, { bytes: mp4(), declaredType: "video/mp4", filename: "clip.mp4" })).asset;
    const { id: wrong } = await createAutomation(t.ctx, t.dev.id, {
      name: "Photo 3", definition: { ...NO_GUARDS, trigger: { type: "event", event: "photo" }, steps: [{ type: "whatsapp", template: "photo_offer", language: "ar", bodyParams: ["20%"], mediaAssetId: video.id }] },
    });
    await expect(activateAutomation(t.ctx, wrong)).rejects.toThrow();

    const photo = (await uploadMedia(t.ctx, t.app.id, { bytes: jpeg(800, 600), declaredType: "image/jpeg", filename: "offer.jpg" })).asset;
    const { id } = await createAutomation(t.ctx, t.dev.id, {
      name: "Photo 4", definition: { ...NO_GUARDS, trigger: { type: "event", event: "photo" }, steps: [{ type: "whatsapp", template: "photo_offer", language: "ar", bodyParams: ["20%"], mediaAssetId: photo.id }] },
    });
    await activateAutomation(t.ctx, id);
    const before = callsTo("POST", "/v23.0/1110001/messages").length;
    await send([{ event_name: "photo", user_id: "w1" }]);
    await cycle();
    const sent = callsTo("POST", "/v23.0/1110001/messages").slice(before);
    expect(sent).toHaveLength(1);
    const header = JSON.parse(sent[0].body).template.components.find((c: { type: string }) => c.type === "header");
    expect(header.parameters[0]).toEqual({ type: "image", image: { link: expect.stringMatching(/\/m\/[^/]+\.jpg$/) } });
    // Saving turned the file's public link on and recorded where it is used.
    const usage = await withSystem((db) => db.one<{ public_access: boolean; uses: string }>(
      "select m.public_access, (select count(*) from platform.media_usages u where u.asset_id = m.id) as uses from platform.media_assets m where m.id = $1", [photo.id]));
    expect(usage).toEqual({ public_access: true, uses: "1" });

    // MMS: Twilio's declared image limits apply, and the image goes as MediaUrl.
    const { id: mms } = await createAutomation(t.ctx, t.dev.id, {
      name: "MMS", definition: { ...NO_GUARDS, trigger: { type: "event", event: "mms" }, steps: [{ type: "sms", text: "Look", mediaAssetId: photo.id }] },
    });
    await activateAutomation(t.ctx, mms);
    await send([{ event_name: "mms", user_id: "s1" }]);
    await cycle();
    expect(lastSms()).toMatchObject({ To: "+14155550101", Body: "Look", MediaUrl: expect.stringMatching(/\/m\/[^/]+\.jpg$/) });
    await expect(createAutomation(t.ctx, t.dev.id, {
      name: "MMS video", definition: { ...NO_GUARDS, trigger: { type: "event", event: "mms" }, steps: [{ type: "sms", text: "Look", mediaAssetId: video.id }] },
    })).rejects.toThrow();
  });
});

describe("campaign composer", () => {
  const sms = () => ({ audienceId, channel: "sms", body: "Sale today, {{user.name}}" });
  it("checks provider, template, variables and media, and reports reach", async () => {
    const ok = await checkCampaign(t.ctx, t.dev.id, sms(), "UTC");
    expect(ok.issues).toEqual([]);
    expect(ok.reach).toEqual({ members: 2, excluded: 1 }); // s2 replied STOP
    const photo = await checkCampaign(t.ctx, t.dev.id, { audienceId, channel: "whatsapp", whatsappTemplate: "photo_offer|ar", whatsappParams: "20%" }, "UTC");
    expect(photo.issues.map((i) => i.level)).toContain("error");
    expect(photo.issues.map((i) => i.message).join(" ")).toMatch(/has a media header \(IMAGE\): choose a media file/);
    const withMedia = await checkCampaign(t.ctx, t.dev.id, { audienceId, channel: "whatsapp", whatsappTemplate: "photo_offer|ar", whatsappParams: "20%", mediaAssetId: crypto.randomUUID() }, "UTC");
    expect(withMedia.issues).toEqual([{ level: "error", message: expect.stringMatching(/media file was not found/) }]);
    const twilioWa = await checkCampaign(t.ctx, t.dev.id, { audienceId, channel: "whatsapp", whatsappProvider: "twilio", whatsappTemplate: "order_ready|en", whatsappParams: "" }, "UTC");
    expect(twilioWa.issues.some((i) => i.level === "error")).toBe(true);
    const otherCheck = await checkCampaign(other.ctx, other.dev.id, { audienceId: crypto.randomUUID(), channel: "sms", body: "x" }, "UTC");
    expect(otherCheck.issues).toContainEqual({ level: "error", message: "Twilio isn't connected in this environment." });
  });

  it("sends a test to one person through the campaign's path", async () => {
    const before = callsTo("POST", `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`).length;
    expect(await sendCampaignTest(t.ctx, t.dev.id, sms(), "s1", "UTC")).toEqual({ ok: true, message: "Sent (message)" });
    expect(lastSms()).toMatchObject({ To: "+14155550101", Body: "Sale today, Sam" });
    expect(await sendCampaignTest(t.ctx, t.dev.id, sms(), "s2", "UTC")).toMatchObject({ ok: false, message: expect.stringMatching(/suppressed/) });
    expect(callsTo("POST", `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`).length).toBe(before + 1);
    await expect(sendCampaignTest(t.ctx, t.dev.id, sms(), "nobody", "UTC")).rejects.toBeInstanceOf(ValidationError);
    await expect(sendCampaignTest(t.ctx, t.dev.id, { audienceId, channel: "push", title: "a", body: "b" }, "s1", "UTC")).rejects.toThrow(/Channels & delivery/);
    await expect(sendCampaignTest({ ...t.ctx, role: "viewer" }, t.dev.id, sms(), "s1", "UTC")).rejects.toThrow();
    await expect(sendCampaignTest(other.ctx, t.dev.id, sms(), "s1", "UTC")).rejects.toThrow();
  });
});
