/**
 * PR 10: campaigns on the automation engine. Audience → channel → message →
 * schedule, sent once (now or later) or on a schedule, with the frequency
 * cap, a basic send status, and the same rights and isolation as flows.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { activateAudience, createAudience, recomputeDueAudiences } from "@/modules/audiences/service";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { activateAutomation, createAutomation, listAutomations } from "@/modules/automation/service";
import { localInputValue } from "@/modules/campaigns/definition";
import { cancelCampaign, createCampaign, getCampaign, listCampaigns, pauseCampaign, sendCampaign, updateCampaign } from "@/modules/campaigns/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let audienceId: string;

const cycle = async () => {
  await enqueueTriggers();
  await stepRuns();
};
const inApp = (extra: Record<string, string> = {}) => ({ audienceId, channel: "in_app", title: "Hi {{user.name}}", body: "New offers", ...extra });
const status = async (id: string) => (await getCampaign(t.ctx, id)).campaign;

beforeAll(async () => {
  t = await makeTenant("camp");
  other = await makeTenant("camp-other");
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  await ingest(sdk, {
    batch: ["vip-1", "vip-2"].map((u) => ({ type: "identify", event_id: crypto.randomUUID(), user_id: u, user_properties: { vip: true, name: u } })),
  }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
  audienceId = (await createAudience(t.ctx, t.dev.id, { name: "VIP", definition: { type: "user_property", property: "vip", op: "eq", value: true } })).id;
  await activateAudience(t.ctx, audienceId);
  await withSystem((db) => db.query("update platform.audiences set last_computed_at = null where id = $1", [audienceId]));
  await recomputeDueAudiences();
});

describe("campaigns", () => {
  let sentId: string;

  it("sends an in-app campaign now, once, and reports its status", async () => {
    sentId = (await createCampaign(t.ctx, t.dev.id, { name: "Spring offer", form: inApp(), timezone: "UTC" })).id;
    expect((await status(sentId)).campaignStatus).toBe("draft");
    expect((await listAutomations(t.ctx, t.dev.id)).map((a) => a.id)).not.toContain(sentId); // not a flow
    await sendCampaign(t.ctx, sentId);
    expect((await status(sentId)).campaignStatus).toBe("sending");
    await cycle();
    const c = await status(sentId);
    expect(c.campaignStatus).toBe("sent");
    expect(c.stats).toEqual({ recipients: 2, inProgress: 0, sent: 2, failed: 0, skipped: 0 });
    const titles = await withSystem((db) => db.query<{ title: string }>("select title from platform.in_app_messages where automation_id = $1 order by title", [sentId]));
    expect(titles.map((r) => r.title)).toEqual(["Hi vip-1", "Hi vip-2"]);

    // Sent means sent: no second send, no edits, and resuming never re-sends.
    await expect(sendCampaign(t.ctx, sentId)).rejects.toBeInstanceOf(ConflictError);
    await expect(updateCampaign(t.ctx, sentId, { name: "Again", form: inApp(), timezone: "UTC" })).rejects.toBeInstanceOf(ConflictError);
    await pauseCampaign(t.ctx, sentId);
    await activateAutomation(t.ctx, sentId);
    await cycle();
    expect((await status(sentId)).stats.recipients).toBe(2);
  });

  it("skips people over the frequency cap and people with no device, with the reason", async () => {
    const capped = (await createCampaign(t.ctx, t.dev.id, { name: "Capped", form: inApp({ capMessages: "1", capHours: "24" }), timezone: "UTC" })).id;
    await sendCampaign(t.ctx, capped);
    await cycle();
    expect((await status(capped)).stats).toMatchObject({ recipients: 2, sent: 0, skipped: 2 });
    const { runs } = await getCampaign(t.ctx, capped);
    expect(runs[0].log.find((l) => l.step === 0)?.detail).toMatch(/Frequency cap/);

    const push = (await createCampaign(t.ctx, t.dev.id, { name: "Push", form: { audienceId, channel: "push", title: "Hey", body: "Come back" }, timezone: "UTC" })).id;
    await sendCampaign(t.ctx, push);
    await cycle();
    const p = await getCampaign(t.ctx, push);
    expect(p.campaign.stats).toMatchObject({ recipients: 2, sent: 0, skipped: 2 });
    expect(p.runs[0].log.find((l) => l.step === 0)?.detail).toBe("No active push token");
  });

  it("schedules a send for later, and repeats a recurring one", async () => {
    const at = localInputValue(new Date(Date.now() + 2 * 3600_000), "Asia/Riyadh");
    const later = (await createCampaign(t.ctx, t.dev.id, { name: "Later", form: inApp({ schedule: "later", sendAt: at }), timezone: "Asia/Riyadh" })).id;
    await sendCampaign(t.ctx, later);
    const c = await status(later);
    expect(c.campaignStatus).toBe("scheduled");
    expect(Math.abs(c.next_fire_at!.getTime() - (Date.now() + 2 * 3600_000))).toBeLessThan(61_000);
    await cycle();
    expect((await status(later)).stats.recipients).toBe(0);
    await withSystem((db) => db.query("update platform.automations set next_fire_at = now() - interval '1 second' where id = $1", [later]));
    await cycle();
    expect((await status(later)).campaignStatus).toBe("sent");

    const daily = (await createCampaign(t.ctx, t.dev.id, { name: "Daily", form: inApp({ schedule: "daily", time: "09:00" }), timezone: "UTC" })).id;
    await sendCampaign(t.ctx, daily);
    expect((await status(daily)).campaignStatus).toBe("recurring");
    await updateCampaign(t.ctx, daily, { name: "Daily tips", form: inApp({ schedule: "weekly", weekday: "1", time: "10:00" }), timezone: "UTC" });
    expect((await status(daily)).definition.trigger).toMatchObject({ type: "schedule", every: "week", weekday: 1, at: "10:00" });
    expect((await cancelCampaign(t.ctx, daily)).cancelled).toBe(0);
    expect((await status(daily)).campaignStatus).toBe("cancelled");
  });

  it("validates the form", async () => {
    const make = (form: Record<string, string>) => createCampaign(t.ctx, t.dev.id, { name: "Bad", form, timezone: "UTC" });
    await expect(make({ ...inApp(), channel: "sms" })).rejects.toThrow(/Choose a channel/);
    await expect(make({ ...inApp(), audienceId: "x" })).rejects.toThrow(/Choose an audience/);
    await expect(make(inApp({ title: "" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(make(inApp({ schedule: "later", sendAt: "2020-01-01T10:00" }))).rejects.toThrow(/has passed/);
    await expect(make({ audienceId, channel: "email" })).rejects.toThrow(/subject/);
    await expect(createCampaign(t.ctx, t.dev.id, { name: "x", form: inApp(), timezone: "UTC" })).rejects.toThrow(/Name the campaign/);
  });

  it("keeps campaigns and flows apart, and follows rights and tenants", async () => {
    const flow = (await createAutomation(t.ctx, t.dev.id, { name: "A flow", definition: { trigger: { type: "event", event: "x" }, steps: [{ type: "delay", amount: 1, unit: "hours" }] } })).id;
    await expect(getCampaign(t.ctx, flow)).rejects.toBeInstanceOf(NotFoundError);
    // Cancelled campaigns go last.
    expect((await listCampaigns(t.ctx, t.dev.id)).map((c) => c.name)).toEqual(["Capped", "Later", "Push", "Spring offer", "Daily tips"]);
    await expect(getCampaign(other.ctx, sentId)).rejects.toThrow(/not found/i);
    await expect(listCampaigns({ ...t.ctx, role: "analyst" }, t.dev.id)).rejects.toThrow(/permission/);
    await expect(createCampaign({ ...t.ctx, role: "viewer" }, t.dev.id, { name: "Nope", form: inApp(), timezone: "UTC" })).rejects.toThrow(/permission/);
  });
});
