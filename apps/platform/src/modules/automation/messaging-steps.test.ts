import { describe, expect, it } from "vitest";
import { describeStep, describeTrigger, parseAutomation } from "./definition";

const trigger = { type: "event", event: "checkout_started" };
const wa = { type: "whatsapp", template: "promo", language: "ar", bodyParams: ["{{user.name}}"] };

describe("messaging steps in flows", () => {
  it("defaults the WhatsApp provider and accepts Twilio", () => {
    const d = parseAutomation({ trigger, steps: [wa, { ...wa, provider: "twilio" }] });
    expect(d.steps[0]).toMatchObject({ type: "whatsapp", provider: "whatsapp_cloud", phoneProperty: "phone" });
    expect(d.steps[1]).toMatchObject({ provider: "twilio" });
    expect(() => parseAutomation({ trigger, steps: [{ ...wa, provider: "gupshup" }] })).toThrow();
    expect(() => parseAutomation({ trigger, steps: [{ ...wa, mediaAssetId: "not-a-uuid" }] })).toThrow(/media file/);
  });

  it("parses session and SMS steps with their limits", () => {
    const d = parseAutomation({ trigger, steps: [{ type: "whatsapp_session", text: "Thanks!" }, { type: "sms", text: "Code 1234" }] });
    expect(d.steps).toEqual([
      { type: "whatsapp_session", text: "Thanks!", phoneProperty: "phone", provider: "whatsapp_cloud" },
      { type: "sms", text: "Code 1234", phoneProperty: "phone", provider: "twilio" },
    ]);
    expect(() => parseAutomation({ trigger, steps: [{ type: "sms", text: "x".repeat(1601) }] })).toThrow();
    expect(() => parseAutomation({ trigger, steps: [{ type: "sms", text: "x", provider: "whatsapp_cloud" }] })).toThrow();
    expect(() => parseAutomation({ trigger, steps: [{ type: "whatsapp_session", text: "" }] })).toThrow(/Enter a message/);
  });

  it("validates wait-for-outcome steps", () => {
    const ok = parseAutomation({ trigger, steps: [wa, { type: "wait_outcome", step: 0, outcome: "read", else: { goto: 3 } }, { type: "push", title: "a", body: "b" }, { type: "sms", text: "fallback" }] });
    expect(ok.steps[1]).toEqual({ type: "wait_outcome", step: 0, outcome: "read", withinHours: 24, else: { goto: 3 } });
    // Must watch an earlier step that reports the outcome.
    expect(() => parseAutomation({ trigger, steps: [{ type: "wait_outcome", step: 0, outcome: "delivered", else: "exit" }] })).toThrow(/earlier step/);
    expect(() => parseAutomation({ trigger, steps: [{ type: "push", title: "a", body: "b" }, { type: "wait_outcome", step: 0, outcome: "read", else: "exit" }] })).toThrow(/doesn't report/);
    expect(() => parseAutomation({ trigger, steps: [{ type: "sms", text: "x" }, { type: "wait_outcome", step: 0, outcome: "read", else: "exit" }] })).toThrow(/doesn't report/);
    // Its "otherwise" jumps forward only.
    expect(() => parseAutomation({ trigger, steps: [wa, { type: "wait_outcome", step: 0, outcome: "replied", else: { goto: 1 } }] })).toThrow(/forward/);
    expect(() => parseAutomation({ trigger, steps: [wa, { type: "wait_outcome", step: 0, outcome: "replied", withinHours: 721, else: "exit" }] })).toThrow();
  });

  it("parses the inbound message trigger", () => {
    const d = parseAutomation({ trigger: { type: "inbound_message", channel: "whatsapp", keyword: " " }, steps: [{ type: "whatsapp_session", text: "Hi" }] });
    expect(d.trigger).toEqual({ type: "inbound_message", channel: "whatsapp" });
    const sms = parseAutomation({ trigger: { type: "inbound_message", channel: "sms", keyword: "JOIN" }, steps: [{ type: "sms", text: "Welcome" }] });
    expect(describeTrigger(sms.trigger)).toBe("When someone replies JOIN on SMS");
    expect(describeTrigger(d.trigger)).toBe("When someone replies on WhatsApp");
    expect(() => parseAutomation({ trigger: { type: "inbound_message", channel: "email" }, steps: [{ type: "exit" }] })).toThrow();
  });

  it("describes the new steps", () => {
    const d = parseAutomation({ trigger, steps: [{ type: "sms", text: "Code 1234" }, { type: "wait_outcome", step: 0, outcome: "delivered", withinHours: 2, else: "exit" }] });
    expect(describeStep(d.steps[0])).toBe("SMS: Code 1234");
    expect(describeStep(d.steps[1])).toBe("Wait up to 2 h for step 1 to be delivered, otherwise exit");
  });
});
