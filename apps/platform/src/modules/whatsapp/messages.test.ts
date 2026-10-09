import { describe, expect, it } from "vitest";
import {
  explainGraphError, graphError, hubSignature, isOptOut, messagesUrl, parseWebhook, placeholderCount, placeholderKeys, renderTemplateText, sessionMessageBody, sessionOpen, templateCreateBody, templateDeleteUrl, templateMessageBody, templateParams, templatesUrl, templateVariables, toE164, verifyHubSignature,
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
    expect(batches[0].messages).toMatchObject([{ from: "966501234567", text: "STOP", type: "text" }, { from: "966501234569", text: "Stop promotions", type: "button" }]);
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: "x" })).toEqual([]);
  });

  it("reads Graph API errors", () => {
    expect(graphError(400, JSON.stringify({ error: { code: 131050, message: "x", error_data: { details: "User opted out" } } }))).toEqual({ code: 131050, message: "131050: User opted out" });
    expect(graphError(502, "<html>")).toEqual({ code: null, message: "HTTP 502" });
  });

  it("reads named and positional template variables", () => {
    expect(placeholderKeys("Hi {{1}}, code {{3}}")).toEqual(["1", "2", "3"]);
    expect(placeholderKeys("Hi {{first_name}}, {{ order_id }} and {{first_name}}")).toEqual(["first_name", "order_id"]);
    expect(placeholderKeys(undefined)).toEqual([]);
    expect(templateVariables([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{name}}" }]))
      .toEqual({ headerFormat: "IMAGE", header: [], body: ["name"], parameterFormat: "NAMED" });
    expect(templateVariables([{ type: "HEADER", text: "Sale {{1}}" }, { type: "BODY", text: "Hi {{1}}" }]))
      .toEqual({ headerFormat: "TEXT", header: ["1"], body: ["1"], parameterFormat: "POSITIONAL" });
    expect(renderTemplateText("Hi {{name}} {{x}}", ["name"], ["Sara"])).toBe("Hi Sara {{x}}");
  });

  it("sends named parameters and media headers", () => {
    const body = templateMessageBody({ to: "+966501234567", name: "promo", language: "ar", bodyParams: ["Sara"], bodyNames: ["first_name"], headerMedia: { kind: "image", link: "https://x/m/a.jpg" } });
    expect(body.template).toEqual({
      name: "promo", language: { code: "ar" },
      components: [
        { type: "header", parameters: [{ type: "image", image: { link: "https://x/m/a.jpg" } }] },
        { type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Sara" }] },
      ],
    });
  });

  it("builds session messages and enforces the 24-hour window", () => {
    expect(sessionMessageBody({ to: "+966501234567", text: "Hello" })).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "966501234567", type: "text", text: { preview_url: false, body: "Hello" } });
    expect(sessionMessageBody({ to: "+1", text: "cap", media: { kind: "image", link: "https://l" } })).toMatchObject({ type: "image", image: { link: "https://l", caption: "cap" } });
    expect(sessionMessageBody({ to: "+1", text: "cap", media: { kind: "audio", link: "https://l" } })).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "1", type: "audio", audio: { link: "https://l" } });
    const now = new Date("2026-10-09T12:00:00Z");
    expect(sessionOpen(new Date("2026-10-08T12:30:00Z"), now)).toBe(true);
    expect(sessionOpen("2026-10-08T11:59:00Z", now)).toBe(false);
    expect(sessionOpen(null, now)).toBe(false);
  });

  it("builds template create and delete requests", () => {
    expect(templateCreateBody({ name: "order_update", language: "en_US", category: "UTILITY", headerText: "Order", body: "Hi {{1}}, order {{2}}", footer: "Thanks", examples: ["Sara", "42", "extra"] })).toEqual({
      name: "order_update", language: "en_US", category: "UTILITY",
      components: [
        { type: "HEADER", format: "TEXT", text: "Order" },
        { type: "BODY", text: "Hi {{1}}, order {{2}}", example: { body_text: [["Sara", "42"]] } },
        { type: "FOOTER", text: "Thanks" },
      ],
    });
    expect(templateDeleteUrl("https://g", "v23.0", "W", "promo", "123")).toBe("https://g/v23.0/W/message_templates?name=promo&hsm_id=123");
    expect(templateDeleteUrl("https://g", "v23.0", "W", "promo")).toBe("https://g/v23.0/W/message_templates?name=promo");
    expect(templatesUrl("https://g", "v23.0", "W")).toContain("rejected_reason,quality_score");
    expect(explainGraphError(190)).toMatch(/token/);
    expect(explainGraphError(424242)).toBeNull();
  });
});
