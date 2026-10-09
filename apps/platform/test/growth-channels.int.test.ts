/**
 * Growth channels against Postgres: organic / direct / unattributed install
 * reasons from the engine, first-touch next to last-touch credit, the channel
 * performance report (channels, evidence, coverage, spend reconciliation),
 * custom channels and rules (validation, RBAC, audit, tenant isolation).
 * No external API is called.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { createLink, handleClick, updateSettings, type LinkRow } from "@/modules/attribution/service";
import { saveSpend } from "@/modules/attribution/spend";
import { channelReport } from "@/modules/channels/report";
import { createChannelRule, createCustomChannel, listChannelConfig, setChannelRuleStatus, setCustomChannelStatus } from "@/modules/channels/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let tiktok: LinkRow;
let email: LinkRow;

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
let ip = 0;

async function click(code: string) {
  const out = await handleClick(code, { method: "GET", headers: new Headers({ "user-agent": ANDROID }), ip: `198.51.100.${++ip}`, query: new URLSearchParams() });
  if (out.status !== 302 || !out.recorded) throw new Error("click not recorded");
  return out.clickId;
}

async function send(events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(t.sdkKey))!;
  const res = await ingest(sdk, { batch: events }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(events.length);
  await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
}

const ev = (name: string, anon: string, o: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), anonymous_id: anon, ...o });
const scope = () => ({ appId: t.app.id, environmentId: t.dev.id, timezone: "Asia/Riyadh", includeSpend: true });
const installOf = (anon: string) =>
  withSystem((db) => db.one<{ match_type: string; match_key: string | null; source: string | null }>(
    "select match_type, match_key, source from platform.attribution_events where environment_id = $1 and anonymous_id = $2 and kind in ('install', 'reinstall')",
    [t.dev.id, anon],
  ));

beforeAll(async () => {
  t = await makeTenant("chan");
  other = await makeTenant("chan-other");
  const dest = { androidUrl: "https://play.google.com/store/apps/details?id=com.example", webUrl: "https://example.com/app" };
  tiktok = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "TikTok", source: "tiktok", medium: "paid_social", campaign: "eid", ...dest });
  email = await createLink(t.ctx, t.app.id, { environmentId: t.dev.id, name: "Newsletter", source: "newsletter", medium: "email", campaign: "winback", ...dest });
});

describe("install reasons", () => {
  it("keeps the store's organic referrer, direct and nothing-matched apart", async () => {
    await send([
      ev("app_installed", "org-play", { context: { platform: "android", campaign: { install_referrer: "utm_source=google-play&utm_medium=organic" } } }),
      ev("app_installed", "org-direct", { context: { platform: "android", attribution: { utm_source: "(direct)", utm_medium: "(none)" } } }),
      ev("app_installed", "org-none", { context: { platform: "ios" } }),
    ]);
    expect(await installOf("org-play")).toMatchObject({ match_type: "organic", match_key: "store_organic", source: null });
    expect(await installOf("org-direct")).toMatchObject({ match_type: "organic", match_key: "direct" });
    expect(await installOf("org-none")).toMatchObject({ match_type: "organic", match_key: null });
  });
});

describe("first and last touch", () => {
  it("records the first touch next to the last touch", async () => {
    const c1 = await click(tiktok.code);
    await send([ev("app_installed", "ft-1", { context: { platform: "android", campaign: { install_referrer: `click_id=${c1}&utm_source=tiktok` } } })]);
    const c2 = await click(email.code);
    await send([ev("app_opened", "ft-1", { context: { platform: "android", attribution: { click_id: c2 } } })]);
    await send([ev("purchase_completed", "ft-1", { properties: { transaction_id: "ft-t1", revenue: 200, currency: "SAR" } })]);
    const row = await withSystem((db) =>
      db.one<{ last: string; first: string; recorded: boolean }>(
        `select l.source as last, f.source as first, c.first_touch_recorded as recorded
           from platform.attribution_conversions c
           join platform.attribution_events l on l.id = c.attribution_event_id
           join platform.attribution_events f on f.id = c.first_attribution_event_id
          where c.environment_id = $1 and c.event_name = 'purchase_completed'`,
        [t.dev.id],
      ),
    );
    expect(row).toEqual({ last: "newsletter", first: "tiktok", recorded: true });
  });
});

describe("channel report", () => {
  it("puts installs, clicks and conversions on channels with evidence and coverage", async () => {
    await send([ev("app_installed", "rep-utm", { context: { platform: "android", attribution: { utm_source: "snapchat", utm_medium: "paid_social" } } })]);
    const last = await channelReport(t.ctx, scope(), { days: 7 });
    const by = Object.fromEntries(last.channels.map((c) => [c.key, c]));
    expect(by.tiktok_ads).toMatchObject({ installs: 1, clicks: 1, evidence: { deterministic: 1 } });
    expect(by.email).toMatchObject({ clicks: 1, reengagements: 1, purchases: 1, revenue: [{ currency: "SAR", amount: 200 }] });
    expect(by.snapchat_ads).toMatchObject({ installs: 1, evidence: { observed: 1 } });
    expect(by.app_store).toMatchObject({ installs: 1, group: "organic" });
    expect(by.direct).toMatchObject({ installs: 1, group: "none" });
    expect(by.unattributed).toMatchObject({ installs: 1, group: "none" });
    expect(last.coverage).toMatchObject({ installs: 5, attributed: 4, unattributed: 1, iosUnattributed: 1, conversions: 1, conversionsCredited: 1, growthMeasured: false });
    expect(by.tiktok_ads.retention).toBeNull();
    expect(last.freshness.lastClickAt).not.toBeNull();

    const first = await channelReport(t.ctx, scope(), { days: 7, model: "first_touch" });
    const fb = Object.fromEntries(first.channels.map((c) => [c.key, c]));
    expect(fb.tiktok_ads.purchases).toBe(1);
    expect(fb.email?.purchases ?? 0).toBe(0);
    expect(first.coverage.firstTouchFallback).toBe(0);
  });

  it("opens with the app's reporting model", async () => {
    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90, reportingModel: "first_touch" });
    expect((await channelReport(t.ctx, scope(), { days: 7 })).model).toBe("first_touch");
    await updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90 });
    expect((await channelReport(t.ctx, scope(), { days: 7 })).model).toBe("first_touch"); // omitted = unchanged
    await expect(updateSettings(t.ctx, t.app.id, { clickLookbackDays: 7, probabilisticWindowHours: 24, conversionWindowDays: 90, reportingModel: "linear" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("reconciles spend: campaign rows win, exact duplicates under two spellings count once, CPI per currency", async () => {
    const scopeSpend = { appId: t.app.id, environmentId: t.dev.id, timezone: "Asia/Riyadh" };
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
    await saveSpend(t.ctx, scopeSpend, { date: today, source: "tiktok", campaign: "", currency: "SAR", amount: "500" });
    await saveSpend(t.ctx, scopeSpend, { date: today, source: "tiktok", campaign: "eid", currency: "SAR", amount: "120" });
    await saveSpend(t.ctx, scopeSpend, { date: today, source: "snapchat", campaign: "", currency: "SAR", amount: "40" });
    await saveSpend(t.ctx, scopeSpend, { date: today, source: "snap", campaign: "", currency: "SAR", amount: "40" });
    const r = await channelReport(t.ctx, scope(), { days: 7, model: "last_touch" });
    const by = Object.fromEntries(r.channels.map((c) => [c.key, c]));
    expect(by.tiktok_ads.spend).toEqual([{ currency: "SAR", amount: 120 }]);
    expect(by.tiktok_ads.cpi).toEqual([{ currency: "SAR", amount: 120 }]);
    expect(by.snapchat_ads.spend).toEqual([{ currency: "SAR", amount: 40 }]);
    expect(r.spendIssues.map((i) => i.rule).sort()).toEqual(["S1", "S2"]);
    const noSpend = await channelReport(t.ctx, { ...scope(), includeSpend: false }, { days: 7 });
    expect(noSpend.totals.spend).toEqual([]);
  });
});

describe("custom channels and rules", () => {
  it("creates a channel and a rule that re-labels touches, and validates them", async () => {
    const ch = await createCustomChannel(t.ctx, t.app.id, { label: "Radio FM", group: "paid" });
    expect(ch.key).toBe("custom_radio_fm");
    await expect(createCustomChannel(t.ctx, t.app.id, { label: "Radio FM", group: "paid" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createCustomChannel(t.ctx, t.app.id, { label: "X", group: "none" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createChannelRule(t.ctx, t.app.id, { channel: "custom_radio_fm" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createChannelRule(t.ctx, t.app.id, { channel: "custom_nope", source: "radio" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createChannelRule(t.ctx, t.app.id, { channel: "unattributed", source: "radio" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createChannelRule(t.ctx, t.app.id, { channel: "email", clickIdParam: "zzclid" })).rejects.toBeInstanceOf(ValidationError);
    const rule = await createChannelRule(t.ctx, t.app.id, { channel: "custom_radio_fm", source: "Radio, sawt fm", priority: "10" });
    expect(rule.conditions).toEqual({ source: ["radio", "sawt_fm"] });

    await send([ev("app_installed", "radio-1", { context: { platform: "android", attribution: { utm_source: "radio" } } })]);
    let r = await channelReport(t.ctx, scope(), { days: 7 });
    expect(r.channels.find((c) => c.key === "custom_radio_fm")).toMatchObject({ installs: 1, label: "Radio FM", group: "paid", builtIn: false });

    await setChannelRuleStatus(t.ctx, t.app.id, rule.id, "paused");
    r = await channelReport(t.ctx, scope(), { days: 7 });
    expect(r.channels.find((c) => c.key === "custom_radio_fm")).toBeUndefined();
    expect(r.channels.find((c) => c.key === "unknown")?.installs).toBeGreaterThanOrEqual(1);

    await setChannelRuleStatus(t.ctx, t.app.id, rule.id, "active");
    await setCustomChannelStatus(t.ctx, t.app.id, ch.id, "archived");
    r = await channelReport(t.ctx, scope(), { days: 7 });
    expect(r.channels.find((c) => c.key === "custom_radio_fm")).toBeUndefined(); // a rule to an archived channel is skipped

    const cfg = await listChannelConfig(t.ctx, t.app.id);
    expect(cfg.channels).toHaveLength(1);
    expect(cfg.rules).toHaveLength(1);
    const audits = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1 and action like 'channels.%' order by created_at", [t.org.id]));
    expect(audits.map((a) => a.action)).toEqual(["channels.channel_created", "channels.rule_created", "channels.rule_updated", "channels.rule_updated", "channels.channel_updated"]);
    await setChannelRuleStatus(t.ctx, t.app.id, rule.id, "deleted");
    expect((await listChannelConfig(t.ctx, t.app.id)).rules).toHaveLength(0);
  });

  it("needs attribution.manage to change and keeps tenants apart", async () => {
    const analyst: TenantContext = { ...t.ctx, role: "analyst" };
    const developer: TenantContext = { ...t.ctx, role: "developer" };
    await expect(createCustomChannel(analyst, t.app.id, { label: "Nope", group: "paid" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createChannelRule(analyst, t.app.id, { channel: "email", source: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listChannelConfig(analyst, t.app.id)).resolves.toBeDefined();
    await expect(listChannelConfig(developer, t.app.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(channelReport(developer, scope(), { days: 7 })).rejects.toBeInstanceOf(ForbiddenError);

    const mine = await createCustomChannel(t.ctx, t.app.id, { label: "Billboards", group: "referral" });
    await expect(setCustomChannelStatus(other.ctx, t.app.id, mine.id, "archived")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createCustomChannel(other.ctx, t.app.id, { label: "Sneaky", group: "paid" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listChannelConfig(other.ctx, t.app.id)).channels).toEqual([]);
    const otherReport = await channelReport(other.ctx, { ...scope(), appId: other.app.id, environmentId: t.dev.id }, { days: 7 });
    expect(otherReport.coverage.installs).toBe(0);
  });
});
