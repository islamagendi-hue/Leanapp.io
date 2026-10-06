import { describe, expect, it } from "vitest";
import {
  graphError, hubSignature, isOptOut, messagesUrl, parseWebhook, placeholderCount, templateMessageBody, templateParams, templatesUrl, toE164, verifyHubSignature,
} from "./messages";

describe("WhatsApp Cloud API messages", () => {
  it("validates and normalizes E.164 numbers", () => {
    expect(toE164("+966 50 123 4567")).toBe("+966501234567");
    expect(toE164("00971-50-123-4567")).toBe("+971501234567");
    expect(toE164("(+20) 100.123.4567")).toBe("+201001234567");
    for (const bad of ["0501234567", "+0123456789", "+12", "+9665012345678901", "966501234567", "", null, {}, "+96650abc4567"]) expect(toE164(bad)).toBeNull();
  });

  it("counts template variables in body and text header", () => {
    expect(placeholderCount("Hi {{1}}, your {{2}} is ready. {{2}}")).toBe(2);
    expect(templateParams([
      { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
      { type: "BODY", text: "Hello {{1}}, {{2}} {{3}}" },
      { type: "BUTTONS", buttons: [] },
    ])).toEqual({ body: 3, header: 1 });
    expect(templateParams([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "No vars" }])).toEqual({ body: 0, header: 0 });
  });

  it("builds a template send request", () => {
    expect(messagesUrl("https://graph.facebook.com", "v23.0", "1234567")).toBe("https://graph.facebook.com/v23.0/1234567/messages");
    expect(templatesUrl("https://graph.facebook.com", "v23.0", "999")).toContain("/v23.0/999/message_templates?fields=");
    expect(templateMessageBody({ to: "+966501234567", name: "cart_reminder", language: "ar", bodyParams: ["سارة", "x".repeat(2000)], headerParams: ["A1"] })).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "966501234567", type: "template",
      template: {
        name: "cart_reminder", language: { code: "ar" },
        components: [
          { type: "header", parameters: [{ type: "text", text: "A1" }] },
          { type: "body", parameters: [{ type: "text", text: "سارة" }, { type: "text", text: "x".repeat(1024) }] },
        ],
      },
    });
    expect((templateMessageBody({ to: "+15551234567", name: "hello_world", language: "en_US", bodyParams: [] }).template as object)).toEqual({ name: "hello_world", language: { code: "en_US" } });
  });

  it("verifies X-Hub-Signature-256 over the raw body", () => {
    const body = '{"entry":[]}';
    const sig = hubSignature("a".repeat(32), body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyHubSignature("a".repeat(32), sig, body)).toBe(true);
    expect(verifyHubSignature("b".repeat(32), sig, body)).toBe(false);
    expect(verifyHubSignature("a".repeat(32), sig, `${body} `)).toBe(false);
    expect(verifyHubSignature("a".repeat(32), null, body)).toBe(false);
    expect(verifyHubSignature("a".repeat(32), sig.replace("sha256=", "sha1="), body)).toBe(false);
  });

  it("recognizes English and Arabic opt-out replies only as whole messages", () => {
    for (const t of ["STOP", " stop ", "Stop!", "unsubscribe", "إيقاف", "ايقاف", "الغاء الاشتراك", "Stop promotions"]) expect(isOptOut(t)).toBe(true);
    for (const t of ["don't stop", "stop by tomorrow", "hello", "", null]) expect(isOptOut(t)).toBe(false);
  });

  it("parses statuses and inbound messages from a webhook", () => {
    const batches = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA",
        changes: [
          { field: "messages", value: {
            metadata: { phone_number_id: "111" },
            statuses: [
              { id: "wamid.1", status: "delivered", recipient_id: "966501234567" },
              { id: "wamid.2", status: "failed", recipient_id: "966501234568", errors: [{ code: 131050, title: "User stopped marketing messages" }] },
              { id: "wamid.3", status: "weird" },
            ],
            messages: [{ from: "966501234567", type: "text", text: { body: "STOP" } }, { from: "966501234569", type: "button", button: { text: "Stop promotions" } }],
          } },
          { field: "account_update", value: {} },
        ],
      }],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].phoneNumberId).toBe("111");
    expect(batches[0].statuses.map((s) => [s.messageId, s.status, s.errorCode])).toEqual([["wamid.1", "delivered", null], ["wamid.2", "failed", 131050]]);
    expect(batches[0].messages).toEqual([{ from: "966501234567", text: "STOP" }, { from: "966501234569", text: "Stop promotions" }]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: "x" })).toEqual([]);
  });

  it("reads Graph API errors", () => {
    expect(graphError(400, JSON.stringify({ error: { code: 131050, message: "x", error_data: { details: "User opted out" } } }))).toEqual({ code: 131050, message: "131050: User opted out" });
    expect(graphError(502, "<html>")).toEqual({ code: null, message: "HTTP 502" });
  });
});
