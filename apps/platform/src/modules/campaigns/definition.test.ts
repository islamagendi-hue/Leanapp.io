import { describe, expect, it } from "vitest";
import { buildCampaign, campaignStatus, formOf, localInputValue, sendsLater } from "./definition";

const AUD = "6f1c3c3e-8a51-4a39-9f43-0a3d5d1d1b11";
const now = new Date("2026-10-08T12:00:00Z");

describe("campaign definitions", () => {
  it("builds one message step and a one-time or recurring trigger", () => {
    const d = buildCampaign({ audienceId: AUD, channel: "push", title: "Hi", body: "Sale", schedule: "now" }, "UTC", now);
    expect(d.trigger).toEqual({ type: "once", audienceId: AUD, at: now.toISOString() });
    expect(d.steps).toEqual([{ type: "push", title: "Hi", body: "Sale" }]);
    expect(d.frequencyCap).toBeNull();
    expect(d.quietHours).toBeNull();

    // 15:30 in Riyadh (UTC+3) is 12:30 UTC.
    const later = buildCampaign({ audienceId: AUD, channel: "in_app", title: "Hi", body: "x", schedule: "later", sendAt: "2026-10-08T15:30", capMessages: "2", quietHours: "on" }, "Asia/Riyadh", now);
    expect(later.trigger).toMatchObject({ type: "once", at: "2026-10-08T12:30:00.000Z" });
    expect(later.frequencyCap).toEqual({ messages: 2, hours: 24 });
    expect(later.quietHours).toEqual({ start: "22:00", end: "08:00" });

    const weekly = buildCampaign({ audienceId: AUD, channel: "whatsapp", whatsappTemplate: "offer|en_US", whatsappParams: "{{user.name}}\n\n20%", schedule: "weekly", weekday: "5", time: "09:15" }, "UTC", now);
    expect(weekly.trigger).toEqual({ type: "schedule", audienceId: AUD, every: "week", weekday: 5, at: "09:15" });
    expect(weekly.steps[0]).toMatchObject({ type: "whatsapp", template: "offer", language: "en_US", bodyParams: ["{{user.name}}", "20%"], phoneProperty: "phone" });
  });

  it("explains what's wrong", () => {
    expect(() => buildCampaign({ audienceId: AUD, channel: "sms" }, "UTC", now)).toThrow("Choose a channel.");
    expect(() => buildCampaign({ audienceId: AUD, channel: "push", title: "x", body: "y", schedule: "later", sendAt: "2026-10-08T11:00" }, "UTC", now)).toThrow(/has passed/);
    expect(() => buildCampaign({ audienceId: AUD, channel: "push", title: "x", body: "y", schedule: "later" }, "UTC", now)).toThrow(/date and time/);
    expect(() => buildCampaign({ audienceId: AUD, channel: "push", body: "y" }, "UTC", now)).toThrow(/title/);
  });

  it("round-trips through the edit form", () => {
    const form = { audienceId: AUD, channel: "email", subject: "News", body: "Text", schedule: "later", sendAt: "2026-10-09T09:00", capMessages: "3", capHours: "12", quietHours: "on" };
    const d = buildCampaign(form, "Africa/Cairo", now);
    expect(formOf(d, "Africa/Cairo", now)).toEqual({ ...form, emailTemplateId: undefined });
    // An unsent "send now" campaign opens as Send now, not as a time in the past.
    expect(formOf(buildCampaign({ ...form, schedule: "now" }, "UTC", now), "UTC", new Date(now.getTime() + 60_000)).schedule).toBe("now");
    expect(localInputValue(new Date("2026-01-01T22:05:00Z"), "Asia/Riyadh")).toBe("2026-01-02T01:05");
    expect(sendsLater(d, now)).toBe(true);
  });

  it("derives the status from the automation", () => {
    const once = buildCampaign({ audienceId: AUD, channel: "push", title: "x", body: "y" }, "UTC", now);
    const daily = buildCampaign({ audienceId: AUD, channel: "push", title: "x", body: "y", schedule: "daily", time: "10:00" }, "UTC", now);
    const base = { next_fire_at: null, fired: false, runs: { active: 0 }, definition: once };
    expect(campaignStatus({ ...base, status: "draft" })).toBe("draft");
    expect(campaignStatus({ ...base, status: "active", next_fire_at: new Date(Date.now() + 60_000) })).toBe("scheduled");
    expect(campaignStatus({ ...base, status: "active", fired: true, runs: { active: 3 } })).toBe("sending");
    expect(campaignStatus({ ...base, status: "active", fired: true })).toBe("sent");
    expect(campaignStatus({ ...base, status: "active", definition: daily })).toBe("recurring");
    expect(campaignStatus({ ...base, status: "archived" })).toBe("cancelled");
  });
});
