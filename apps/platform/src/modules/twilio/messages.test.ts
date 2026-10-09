import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  basicAuth, contentListUrl, explainTwilioError, messageForm, messagesUrl, parseContent, parseTwilioCallback, twilioError, twilioSignature,
  verifyTwilioSignature, type TwilioCredentials,
} from "./messages";

const SID = `AC${"a".repeat(32)}`;
const MSG = `SM${"b".repeat(32)}`;
const creds: TwilioCredentials = { accountSid: SID, authToken: "token", messagingServiceSid: `MG${"c".repeat(32)}`, fromNumber: null, whatsappFrom: "+14155550000" };

describe("Twilio messages", () => {
  it("builds URLs and auth", () => {
    expect(messagesUrl("https://api.twilio.com", SID)).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(contentListUrl("https://content.twilio.com")).toBe("https://content.twilio.com/v1/ContentAndApprovals?PageSize=100");
    expect(basicAuth(creds)).toBe(`Basic ${Buffer.from(`${SID}:token`).toString("base64")}`);
  });

  it("builds SMS and WhatsApp forms", () => {
    const sms = messageForm(creds, { channel: "sms", to: "+14155550100", body: "Hi", mediaUrls: ["https://x/m/1.jpg"], statusCallback: "https://cb" });
    expect(Object.fromEntries(sms)).toEqual({ To: "+14155550100", MessagingServiceSid: creds.messagingServiceSid, Body: "Hi", MediaUrl: "https://x/m/1.jpg", StatusCallback: "https://cb" });
    const fromNumber = messageForm({ ...creds, messagingServiceSid: null, fromNumber: "+14155559999" }, { channel: "sms", to: "+1", body: "x".repeat(2000), statusCallback: "u" });
    expect(fromNumber.get("From")).toBe("+14155559999");
    expect(fromNumber.get("Body")).toHaveLength(1600);
    const wa = messageForm(creds, { channel: "whatsapp", to: "+966501234567", contentSid: `HX${"d".repeat(32)}`, contentVariables: { 1: "Sara" }, statusCallback: "u" });
    expect(wa.get("To")).toBe("whatsapp:+966501234567");
    expect(wa.get("From")).toBe("whatsapp:+14155550000");
    expect(wa.get("ContentVariables")).toBe('{"1":"Sara"}');
    expect(wa.get("Body")).toBeNull();
  });

  it("signs callbacks the way Twilio documents (URL + sorted params, HMAC-SHA1)", () => {
    const params = new URLSearchParams({ To: "+1", MessageSid: MSG, Body: "STOP" });
    const expected = createHmac("sha1", "token").update(`https://cb/x` + `Body` + `STOP` + `MessageSid` + MSG + `To` + `+1`).digest("base64");
    expect(twilioSignature("token", "https://cb/x", params)).toBe(expected);
    expect(verifyTwilioSignature("token", expected, "https://cb/x", params)).toBe(true);
    expect(verifyTwilioSignature("other", expected, "https://cb/x", params)).toBe(false);
    expect(verifyTwilioSignature("token", expected, "https://cb/y", params)).toBe(false);
    expect(verifyTwilioSignature("token", null, "https://cb/x", params)).toBe(false);
  });

  it("parses status callbacks and inbound messages", () => {
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: MSG, MessageStatus: "delivered" }))).toEqual({ kind: "status", messageSid: MSG, status: "delivered", errorCode: null, error: null });
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: MSG, MessageStatus: "undelivered", ErrorCode: "21610" }))).toMatchObject({ status: "failed", errorCode: 21610, error: expect.stringMatching(/replied STOP/) });
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: MSG, MessageStatus: "queued" }))).toEqual({ kind: "ignored" });
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: "bogus", MessageStatus: "sent" }))).toEqual({ kind: "ignored" });
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: MSG, From: "+14155550100", To: "+14155559999", Body: "STOP", OptOutType: "STOP" })))
      .toEqual({ kind: "inbound", messageSid: MSG, channel: "sms", from: "+14155550100", to: "+14155559999", body: "STOP", optOutType: "STOP", numMedia: 0 });
    expect(parseTwilioCallback(new URLSearchParams({ MessageSid: MSG, From: "whatsapp:+966501234567", To: "whatsapp:+1", Body: "hi", NumMedia: "1" })))
      .toMatchObject({ channel: "whatsapp", from: "+966501234567", to: "+1", numMedia: 1 });
  });

  it("reads errors", () => {
    expect(twilioError(401, JSON.stringify({ code: 20003, message: "Authenticate" }))).toEqual({ code: 20003, message: "20003: Authenticate" });
    expect(twilioError(502, "<html>")).toEqual({ code: null, message: "HTTP 502" });
    expect(explainTwilioError(63016)).toMatch(/24 hours/);
    expect(explainTwilioError(1)).toBeNull();
  });

  it("parses Content API templates with their WhatsApp approval", () => {
    const sid = `HX${"e".repeat(32)}`;
    expect(parseContent({
      sid, friendly_name: "promo", language: "ar", variables: { 1: "Sara" }, types: { "twilio/text": { body: "Hi {{1}}" } },
      approval_requests: { name: "promo_wa", status: "approved", category: "marketing" },
    })).toMatchObject({ sid, name: "promo_wa", language: "ar", status: "APPROVED", category: "MARKETING", body: "Hi {{1}}", variables: { 1: "Sara" } });
    expect(parseContent({ sid, friendly_name: "draft", types: {} })).toMatchObject({ status: "UNSUBMITTED", category: null, language: "en" });
    expect(parseContent({ sid: "bad" })).toBeNull();
  });
});
