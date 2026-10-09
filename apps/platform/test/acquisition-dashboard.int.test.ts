/**
 * The Acquisition dashboard against Postgres: metrics by source and campaign
 * with their provenance, spend origin (imported vs entered by hand), cost
 * import state as coverage warnings, permission-gated parts, and tenant
 * isolation. No external API is called: the ad connection and its capability
 * states are written directly, as a sync would leave them.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { localDate } from "@/modules/analytics/range";
import { createLink, handleClick, type LinkRow } from "@/modules/attribution/service";
import { saveSpend } from "@/modules/attribution/spend";
import { acquisitionDashboard } from "@/modules/channels/provenance-data";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let tiktok: LinkRow;

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const TZ = "Asia/Riyadh";
const today = () => localDate(new Date(), TZ);
const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000), TZ);

async function click(code: string, n: number) {
  const out = await handleClick(code, { method: "GET", headers: new Headers({ "user-agent": ANDROID }), ip: `198.51.100.${n}`, query: new URLSearchParams() });
  if (out.status !== 302 || !out.recorded) throw new Error("click not recorded");
  return out.clickId;
}

async function send(tenant: T, events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(tenant.sdkKey))!;
  const res = await ingest(sdk, { batch: events }, { mode: "batch" });
  expect((res.body as { accepted: number }).accepted).toBe(events.length);
  await processPendingEvents({ environmentId: sdk.environmentId, limit: 1000 });
}

const ev = (name: string, anon: string, o: Record<string, unknown> = {}) => ({ type: "track", event_name: name, event_id: crypto.randomUUID(), anonymous_id: anon, ...o });
const scope = (o: Partial<{ includeSpend: boolean; includeIntegrations: boolean }> = {}) => ({
  appId: t.app.id, environmentId: t.dev.id, timezone: TZ, includeSpend: true, includeIntegrations: true, ...o,
});

beforeAll(async () => {
  t = await makeTenant("dash");
  other = await makeTenant("dash-other");
  tiktok = await createLink(t.ctx, t.app.id, {
    environmentId: t.dev.id, name: "TikTok", source: "tiktok", medium: "paid_social", campaign: "eid",
    androidUrl: "https://play.google.com/store/apps/details?id=com.example", webUrl: "https://example.com/app",
  });
  const c1 = await click(tiktok.code, 1);
  const c2 = await click(tiktok.code, 2);
  await send(t, [
    ev("app_installed", "tk-1", { context: { platform: "android", campaign: { install_referrer: `click_id=${c1}&utm_source=tiktok` } } }),
    ev("app_installed", "tk-2", { context: { platform: "android", campaign: { install_referrer: `click_id=${c2}&utm_source=tiktok` } } }),
    ev("app_installed", "meta-1", { context: { platform: "android", attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "ramadan" } } }),
    ev("app_installed", "store-1", { context: { platform: "android", campaign: { install_referrer: "utm_source=google-play&utm_medium=organic" } } }),
    ev("app_installed", "ios-1", { context: { platform: "ios" } }),
  ]);
  await send(t, [
    ev("signup_completed", "tk-1"),
    ev("purchase_completed", "tk-1", { properties: { transaction_id: "d-t1", revenue: 300, currency: "SAR" } }),
    ev("purchase_completed", "web-only", { properties: { transaction_id: "d-t2", revenue: 50, currency: "SAR" } }),
  ]);
  const spendScope = { appId: t.app.id, environmentId: t.dev.id, timezone: TZ };
  await saveSpend(t.ctx, spendScope, { date: today(), source: "tiktok", campaign: "eid", currency: "SAR", amount: "100" });
  await withSystem(async (db) => {
    const conn = await db.one<{ id: string }>(
      `insert into platform.integration_connections (organization_id, app_id, environment_id, provider) values ($1, $2, $3, 'tiktok_ads') returning id`,
      [t.org.id, t.app.id, t.dev.id],
    );
    await db.query(
      `insert into platform.integration_capabilities (organization_id, connection_id, capability, enabled, status, data_fresh_through, config)
       values ($1, $2, 'ad_reporting', true, 'error', $3, '{}'), ($1, $2, 'spend_import', true, 'verified', $3, '{"spend_source":"tiktok"}')`,
      [t.org.id, conn!.id, daysAgo(1)],
    );
    // What a cost import writes: a row with origin 'import', next to the hand-entered one.
    await db.query(
      `insert into platform.ad_spend_daily (organization_id, environment_id, day, source, campaign, currency, amount, origin, connection_id)
       values ($1, $2, $3, 'tiktok', 'eid', 'SAR', 50, 'import', $4)`,
      [t.org.id, t.dev.id, daysAgo(1), conn!.id],
    );
  });
});

describe("acquisition dashboard", () => {
  it("labels every metric by source with its provenance, and marks CAC and ROAS incomplete where data is partial", async () => {
    const { dashboard: d } = await acquisitionDashboard(t.ctx, scope(), { days: 7 });
    const tk = d.channels.find((c) => c.key === "tiktok_ads")!.metrics;
    expect(tk.users).toMatchObject({ value: 2, provenance: "observed" });
    expect(tk.installs).toMatchObject({ value: 2, provenance: "observed", modeled: 0 });
    expect(tk.signups.value).toBe(1);
    expect(tk.purchases.value).toBe(1);
    expect(tk.revenue).toMatchObject({ value: [{ currency: "SAR", amount: 300 }], provenance: "observed" });
    expect(tk.spend).toMatchObject({ value: [{ currency: "SAR", amount: 150 }], provenance: "imported", origins: ["import", "manual"] });
    expect(tk.cac.value).toEqual([{ currency: "SAR", amount: 75 }]);
    expect(tk.roas.value).toEqual([{ currency: "SAR", value: 2 }]);
    // The TikTok reporting import is failing, an iOS install is unattributed and one purchase has no install on record.
    expect(tk.cac).toMatchObject({ provenance: "imported", complete: false });
    expect(tk.cac.reasons).toEqual(expect.arrayContaining(["spend_import_failing", "unattributed_users"]));
    expect(tk.roas.reasons).toEqual(expect.arrayContaining(["spend_import_failing", "unattributed_conversions"]));
    // Meta has an install and no spend: unavailable, never 0.
    expect(d.channels.find((c) => c.key === "meta_ads")!.metrics.cac).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_spend"] });
    expect(d.totals.cac.reasons).toContain("paid_channels_without_spend");
    expect(d.totals.activated).toMatchObject({ provenance: "unavailable", reasons: ["growth_not_measured"] });
    const ids = d.warnings.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining(["paid_without_spend", "import_failing", "unattributed_installs", "unattributed_conversions", "growth_not_measured"]));
    expect(d.warnings.find((w) => w.id === "import_failing")?.params.provider).toBe("TikTok Ads");
    expect(d.coverage).toMatchObject({ paidChannels: 2, paidChannelsWithSpend: 1, installs: 5, conversions: 3, creditedConversions: 2 });
  });

  it("breaks the same numbers down by campaign, with spend matched by name", async () => {
    const { dashboard: d } = await acquisitionDashboard(t.ctx, scope(), { days: 7 });
    const eid = d.campaigns.find((c) => c.channel === "tiktok_ads" && c.campaign === "eid")!;
    expect(eid.metrics.users.value).toBe(2);
    expect(eid.metrics.purchases.value).toBe(1);
    expect(eid.metrics.spend.value).toEqual([{ currency: "SAR", amount: 150 }]);
    expect(eid.metrics.cac.value).toEqual([{ currency: "SAR", amount: 75 }]);
    const ramadan = d.campaigns.find((c) => c.campaign === "ramadan")!;
    expect(ramadan).toMatchObject({ channel: "meta_ads" });
    expect(ramadan.metrics.spend).toMatchObject({ provenance: "unavailable", reasons: ["no_spend"] });
    expect(d.campaigns.find((c) => c.channel === "unattributed")!.metrics.purchases.value).toBeGreaterThanOrEqual(1);
  });

  it("leaves out spend without the analytics permission, and integration state without the integrations permission", async () => {
    const hidden = (await acquisitionDashboard(t.ctx, scope({ includeSpend: false }), { days: 7 })).dashboard;
    expect(hidden.totals.spend).toMatchObject({ value: null, reasons: ["no_spend_access"] });
    expect(hidden.channels.every((c) => c.metrics.spend.value === null)).toBe(true);
    expect(hidden.campaigns.every((c) => c.metrics.spend.value === null && !c.wholeSource)).toBe(true);
    expect(hidden.warnings.map((w) => w.id)).toContain("spend_hidden");
    const noIntegrations = (await acquisitionDashboard(t.ctx, scope({ includeIntegrations: false }), { days: 7 })).dashboard;
    expect(noIntegrations.warnings.map((w) => w.id)).not.toContain("import_failing");
    expect(noIntegrations.channels.find((c) => c.key === "tiktok_ads")!.metrics.spend.complete).toBe(true);
  });

  it("never shows another organization's data", async () => {
    const own = (await acquisitionDashboard(other.ctx, { ...scope(), appId: other.app.id, environmentId: other.dev.id }, { days: 7 })).dashboard;
    expect(own.campaigns).toEqual([]);
    expect(own.totals.users.value).toBe(0);
    expect(own.totals.spend.value).toBeNull();
    expect(own.warnings.map((w) => w.id)).not.toContain("import_failing");
    // Asking with another organization's environment id reads nothing (row-level security).
    const cross = (await acquisitionDashboard(other.ctx, { ...scope(), appId: other.app.id }, { days: 7 })).dashboard;
    expect(cross.campaigns).toEqual([]);
    expect(cross.totals.installs.value).toBe(0);
    expect(cross.totals.spend.value).toBeNull();
  });
});
