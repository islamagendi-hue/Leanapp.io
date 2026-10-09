import { describe, expect, it } from "vitest";
import { buildAcquisitionDashboard, MAX_CAMPAIGNS, weakest, type DashboardInput, type SpendImportState } from "./provenance";
import { buildChannelReport, type ChannelReportInput } from "./report-pure";

const key = (o: Partial<{ source: string | null; medium: string | null; network: string | null; match_type: string; match_key: string | null }> = {}) => ({
  source: null, medium: null, network: null, match_type: "organic", match_key: null, ...o,
});
const tiktok = key({ source: "tiktok", medium: "paid_social", network: "tiktok", match_type: "deterministic" });
const meta = key({ source: "meta", medium: "paid_social", network: "meta", match_type: "deterministic" });
const store = key({ match_key: "store_organic" });
const cohort = (k: ReturnType<typeof key>, people: number, activated = 0) => ({
  ...k, people, activated, d1_eligible: 0, d1: 0, d7_eligible: 0, d7: 0, d30_eligible: 0, d30: 0,
});
const fresh = { lastClickAt: null, lastAttributionAt: null, lastProcessedAt: null, lastConversionAt: new Date("2026-10-05"), lastSpendDay: null, lastSpendSavedAt: null };

function report(o: Partial<ChannelReportInput> = {}) {
  return buildChannelReport({
    model: "last_touch", classify: {}, clicks: [], growthMeasured: true, firstTouchFallback: 0, providerReported: 0, freshness: fresh,
    attributions: [
      { ...tiktok, kind: "install", n: 10, ios: 0 },
      { ...store, kind: "install", n: 5, ios: 0 },
    ],
    cohort: [cohort(tiktok, 10, 4), cohort(store, 5, 1)],
    conversions: [
      { ...tiktok, credited: true, kind: "purchase", currency: "SAR", n: 4, revenue: 400 },
      { ...tiktok, credited: true, kind: "signup", currency: null, n: 6, revenue: 0 },
    ],
    spend: [{ day: "2026-10-01", source: "tiktok", campaign: "", currency: "SAR", amount: 200 }],
    ...o,
  });
}

function input(o: Partial<DashboardInput> = {}): DashboardInput {
  return {
    report: report(), classify: {}, range: { from: "2026-09-10", to: "2026-10-09" }, today: "2026-10-09", spendAccess: true,
    spend: [{ source: "tiktok", campaign: "", currency: "SAR", origin: "manual", amount: 200 }],
    campaignCounts: [], campaignConversions: [], imports: null, ...o,
  };
}

const imp = (o: Partial<SpendImportState> = {}): SpendImportState => ({
  provider: "tiktok_ads", providerName: "TikTok Ads", source: "tiktok", reportingEnabled: true, reportingStatus: "verified",
  spendEnabled: true, spendStatus: "verified", freshThrough: "2026-10-08", ...o,
});

describe("buildAcquisitionDashboard: provenance labels", () => {
  it("labels LeanApp's own counts observed and spend imported, with where the spend came from", () => {
    const d = buildAcquisitionDashboard(input());
    const tk = d.channels.find((c) => c.key === "tiktok_ads")!.metrics;
    expect(tk.users).toMatchObject({ value: 10, provenance: "observed", complete: true });
    expect(tk.installs).toMatchObject({ value: 10, provenance: "observed", modeled: 0 });
    expect(tk.signups).toMatchObject({ value: 6, provenance: "observed" });
    expect(tk.activated).toMatchObject({ value: 4, provenance: "observed" });
    expect(tk.purchases).toMatchObject({ value: 4, provenance: "observed" });
    expect(tk.revenue).toMatchObject({ value: [{ currency: "SAR", amount: 400 }], provenance: "observed" });
    expect(tk.spend).toMatchObject({ value: [{ currency: "SAR", amount: 200 }], provenance: "imported", origins: ["manual"], complete: true });
    expect(tk.cac).toMatchObject({ value: [{ currency: "SAR", amount: 20 }], provenance: "imported", complete: true, reasons: [] });
    expect(tk.roas).toMatchObject({ value: [{ currency: "SAR", value: 2 }], provenance: "imported", complete: true });
  });

  it("labels installs modeled when every one was matched on device signals, and counts the modeled share otherwise", () => {
    const prob = key({ source: "tiktok", network: "tiktok", match_type: "probabilistic" });
    const d = buildAcquisitionDashboard(input({
      report: report({ attributions: [{ ...tiktok, kind: "install", n: 3, ios: 0 }, { ...prob, kind: "install", n: 2, ios: 0 }, { ...key({ source: "snapchat", network: "snapchat", match_type: "probabilistic" }), kind: "install", n: 4, ios: 0 }] }),
    }));
    expect(d.channels.find((c) => c.key === "tiktok_ads")!.metrics.installs).toMatchObject({ value: 5, provenance: "observed", modeled: 2 });
    expect(d.channels.find((c) => c.key === "snapchat_ads")!.metrics.installs).toMatchObject({ value: 4, provenance: "modeled", modeled: 4 });
  });

  it("marks activation unavailable when the growth model is off", () => {
    const d = buildAcquisitionDashboard(input({ report: report({ growthMeasured: false }) }));
    expect(d.totals.activated).toMatchObject({ value: null, provenance: "unavailable", reasons: ["growth_not_measured"] });
    expect(d.warnings.map((w) => w.id)).toContain("growth_not_measured");
  });

  it("takes the weakest label of a derived metric's inputs", () => {
    expect(weakest("observed", "imported")).toBe("imported");
    expect(weakest("modeled", "imported", "observed")).toBe("modeled");
    expect(weakest("observed", "unavailable")).toBe("unavailable");
    expect(weakest()).toBe("observed");
  });
});

describe("buildAcquisitionDashboard: CAC and ROAS completeness", () => {
  it("leaves CAC and ROAS unavailable without spend, and says whether a cost import exists", () => {
    const noSpend = { report: report({ spend: [] }), spend: [] };
    const d = buildAcquisitionDashboard(input({ ...noSpend, imports: [] }));
    expect(d.totals.spend).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_spend"] });
    expect(d.totals.cac).toMatchObject({ value: null, provenance: "unavailable" });
    expect(d.totals.roas).toMatchObject({ value: null, provenance: "unavailable" });
    const tk = d.channels.find((c) => c.key === "tiktok_ads")!.metrics;
    expect(tk.spend.reasons).toEqual(["no_spend"]);
    expect(d.channels.find((c) => c.key === "app_store")!.metrics.spend.reasons).toEqual(["not_paid"]);
    expect(d.warnings.map((w) => w.id)).toContain("no_cost_import");
    // Integrations not visible to the viewer: no claim about imports either way.
    expect(buildAcquisitionDashboard(input({ ...noSpend, imports: null })).warnings.map((w) => w.id)).toContain("no_spend");
  });

  it("marks total CAC and ROAS incomplete when a paid channel with activity has no spend", () => {
    const d = buildAcquisitionDashboard(input({
      report: report({ attributions: [{ ...tiktok, kind: "install", n: 10, ios: 0 }, { ...meta, kind: "install", n: 3, ios: 0 }] }),
    }));
    expect(d.totals.cac).toMatchObject({ complete: false, reasons: ["paid_channels_without_spend"] });
    expect(d.totals.roas.complete).toBe(false);
    expect(d.totals.cac.value).toEqual([{ currency: "SAR", amount: 13.33 }]);
    expect(d.channels.find((c) => c.key === "meta_ads")!.metrics.cac).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_spend"] });
    expect(d.warnings.find((w) => w.id === "paid_without_spend")).toMatchObject({ params: { n: 1 }, labels: ["Meta (Facebook, Instagram)"] });
    expect(d.coverage).toMatchObject({ paidChannels: 2, paidChannelsWithSpend: 1 });
  });

  it("marks spend, CAC and ROAS incomplete on a channel whose cost import is failing", () => {
    const d = buildAcquisitionDashboard(input({ imports: [imp({ spendStatus: "error" })] }));
    const tk = d.channels.find((c) => c.key === "tiktok_ads")!.metrics;
    expect(tk.spend).toMatchObject({ provenance: "imported", complete: false, reasons: ["spend_import_failing"] });
    expect(tk.cac).toMatchObject({ complete: false, reasons: ["spend_import_failing"] });
    expect(tk.roas.complete).toBe(false);
    expect(d.totals.cac.reasons).toContain("spend_import_failing");
    expect(d.warnings.find((w) => w.id === "import_failing")?.params).toEqual({ provider: "TikTok Ads" });
  });

  it("flags a cost import behind the range end, allowing the networks' restatement lag", () => {
    const stale = buildAcquisitionDashboard(input({ imports: [imp({ freshThrough: "2026-10-01" })] }));
    expect(stale.channels.find((c) => c.key === "tiktok_ads")!.metrics.cac.reasons).toEqual(["spend_import_stale"]);
    expect(stale.warnings.find((w) => w.id === "import_stale")?.params).toEqual({ provider: "TikTok Ads", day: "2026-10-01" });
    // Two days behind today is normal.
    expect(buildAcquisitionDashboard(input({ imports: [imp({ freshThrough: "2026-10-07" })] })).warnings.map((w) => w.id)).not.toContain("import_stale");
    // A past range only needs data up to its own end.
    expect(buildAcquisitionDashboard(input({ range: { from: "2026-08-01", to: "2026-08-31" }, imports: [imp({ freshThrough: "2026-09-02" })] })).warnings.map((w) => w.id)).not.toContain("import_stale");
  });

  it("says when ad reporting is imported without cost import, and when cost import has not been verified", () => {
    const d = buildAcquisitionDashboard(input({ imports: [imp({ spendEnabled: false, spendStatus: "not_configured" }), imp({ provider: "meta_ads", providerName: "Meta Ads", source: "meta", spendStatus: "unverified" })] }));
    expect(d.warnings.filter((w) => w.id === "reporting_without_cost_import").map((w) => w.params.provider)).toEqual(["TikTok Ads"]);
    expect(d.warnings.filter((w) => w.id === "import_unverified").map((w) => w.params.provider)).toEqual(["Meta Ads"]);
  });

  it("marks per-channel CAC incomplete when installs are unattributed, but not the blended total", () => {
    const d = buildAcquisitionDashboard(input({
      report: report({ attributions: [{ ...tiktok, kind: "install", n: 10, ios: 0 }, { ...key(), kind: "install", n: 4, ios: 3 }] }),
    }));
    expect(d.channels.find((c) => c.key === "tiktok_ads")!.metrics.cac).toMatchObject({ complete: false, reasons: ["unattributed_users"] });
    expect(d.totals.cac.complete).toBe(true);
    expect(d.warnings.find((w) => w.id === "unattributed_installs")?.params).toEqual({ n: 4, total: 14, ios: 3 });
  });

  it("marks per-channel ROAS incomplete when conversions have no install on record", () => {
    const d = buildAcquisitionDashboard(input({
      report: report({
        conversions: [
          { ...tiktok, credited: true, kind: "purchase", currency: "SAR", n: 4, revenue: 400 },
          { ...key(), credited: false, kind: "purchase", currency: "SAR", n: 1, revenue: 50 },
        ],
      }),
    }));
    expect(d.channels.find((c) => c.key === "tiktok_ads")!.metrics.roas).toMatchObject({ value: [{ currency: "SAR", value: 2 }], complete: false, reasons: ["unattributed_conversions"] });
    expect(d.totals.roas).toMatchObject({ value: [{ currency: "SAR", value: 2.25 }], complete: true });
    expect(d.warnings.find((w) => w.id === "unattributed_conversions")?.params).toEqual({ n: 1, total: 5 });
  });

  it("never divides across currencies", () => {
    const d = buildAcquisitionDashboard(input({
      report: report({
        conversions: [{ ...tiktok, credited: true, kind: "purchase", currency: "USD", n: 2, revenue: 100 }],
        spend: [{ day: "2026-10-01", source: "tiktok", campaign: "", currency: "SAR", amount: 200 }],
      }),
    }));
    const tk = d.channels.find((c) => c.key === "tiktok_ads")!.metrics;
    expect(tk.roas).toMatchObject({ value: null, provenance: "unavailable", reasons: ["currency_mismatch"] });
    const mixed = buildAcquisitionDashboard(input({
      report: report({
        conversions: [
          { ...tiktok, credited: true, kind: "purchase", currency: "USD", n: 2, revenue: 100 },
          { ...tiktok, credited: true, kind: "purchase", currency: "SAR", n: 1, revenue: 300 },
        ],
      }),
    }));
    expect(mixed.channels.find((c) => c.key === "tiktok_ads")!.metrics.roas).toMatchObject({ value: [{ currency: "SAR", value: 1.5 }], complete: false, reasons: ["currency_mismatch"] });
  });

  it("leaves revenue and ROAS unavailable before any revenue event arrives, rather than showing 0", () => {
    const d = buildAcquisitionDashboard(input({ report: report({ conversions: [], freshness: { ...fresh, lastConversionAt: null } }) }));
    expect(d.totals.revenue).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_revenue_events"] });
    expect(d.totals.roas).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_revenue_events"] });
    expect(d.warnings.map((w) => w.id)).toContain("no_revenue_events");
    // Revenue events exist, none in this range: 0 is a real, observed number.
    const zero = buildAcquisitionDashboard(input({ report: report({ conversions: [] }) }));
    expect(zero.totals.revenue).toMatchObject({ value: [], provenance: "observed" });
    expect(zero.totals.roas).toMatchObject({ value: [{ currency: "SAR", value: 0 }], provenance: "imported" });
  });

  it("hides spend, CAC and ROAS without the analytics permission", () => {
    const d = buildAcquisitionDashboard(input({ spendAccess: false, report: report({ spend: [] }), spend: [] }));
    for (const m of [d.totals.spend, d.totals.cac, d.totals.roas]) expect(m).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_spend_access"] });
    expect(d.warnings.map((w) => w.id)).toEqual(expect.arrayContaining(["spend_hidden"]));
    expect(d.warnings.map((w) => w.id)).not.toContain("no_spend");
  });

  it("CAC is unavailable for a channel with spend but no new users", () => {
    const d = buildAcquisitionDashboard(input({ report: report({ cohort: [cohort(store, 5)] }) }));
    expect(d.channels.find((c) => c.key === "tiktok_ads")!.metrics.cac).toMatchObject({ value: null, provenance: "unavailable", reasons: ["no_users"] });
  });

  it("lists warnings before notes", () => {
    const d = buildAcquisitionDashboard(input({ report: report({ growthMeasured: false, providerReported: 3, attributions: [{ ...key(), kind: "install", n: 1, ios: 0 }] }) }));
    const sev = d.warnings.map((w) => w.severity);
    expect(sev).toEqual([...sev].sort((a, b) => Number(a === "info") - Number(b === "info")));
    expect(d.warnings.find((w) => w.id === "provider_reported")?.params).toEqual({ n: 3 });
  });
});

describe("buildAcquisitionDashboard: campaigns", () => {
  const campaignInput = (o: Partial<DashboardInput> = {}) => input({
    campaignCounts: [
      { ...tiktok, campaign: "Launch", installs: 6, modeled: 0, users: 6, activated: 2 },
      { ...tiktok, campaign: "launch ", installs: 1, modeled: 0, users: 1, activated: 0 },
      { ...tiktok, campaign: "Retarget", installs: 3, modeled: 1, users: 3, activated: 1 },
      { ...store, campaign: null, installs: 5, modeled: 0, users: 5, activated: 1 },
    ],
    campaignConversions: [
      { ...tiktok, campaign: "Launch", credited: true, kind: "purchase", currency: "SAR", n: 3, revenue: 300 },
      { ...key(), campaign: null, credited: false, kind: "purchase", currency: "SAR", n: 1, revenue: 20 },
    ],
    spend: [
      { source: "tiktok", campaign: "launch", currency: "SAR", origin: "import", amount: 140 },
      { source: "TikTok", campaign: "", currency: "SAR", origin: "manual", amount: 60 },
    ],
    ...o,
  });

  it("puts installs, conversions and spend on one row per channel and campaign, ignoring case", () => {
    const d = buildAcquisitionDashboard(campaignInput());
    const launch = d.campaigns.find((c) => c.channel === "tiktok_ads" && c.campaign?.toLowerCase() === "launch")!;
    expect(launch.metrics.users.value).toBe(7);
    expect(launch.metrics.activated.value).toBe(2);
    expect(launch.metrics.revenue.value).toEqual([{ currency: "SAR", amount: 300 }]);
    expect(launch.metrics.spend).toMatchObject({ value: [{ currency: "SAR", amount: 140 }], origins: ["import"] });
    expect(launch.metrics.cac.value).toEqual([{ currency: "SAR", amount: 20 }]);
    expect(launch.metrics.roas.value).toEqual([{ currency: "SAR", value: 2.14 }]);
    // Spend entered for the whole source is its own row, never spread over campaigns.
    const whole = d.campaigns.find((c) => c.wholeSource)!;
    expect(whole).toMatchObject({ channel: "tiktok_ads", campaign: null });
    expect(whole.metrics.spend).toMatchObject({ value: [{ currency: "SAR", amount: 60 }], origins: ["manual"] });
    expect(whole.metrics.cac.reasons).toContain("no_users");
    // A paid campaign with installs and no spend of its own.
    const retarget = d.campaigns.find((c) => c.campaign === "Retarget")!;
    expect(retarget.metrics.installs).toMatchObject({ value: 3, modeled: 1 });
    expect(retarget.metrics.cac).toMatchObject({ provenance: "unavailable", reasons: ["no_spend"] });
    // Conversions without an install on record land on Unattributed.
    expect(d.campaigns.find((c) => c.channel === "unattributed")!.metrics.purchases.value).toBe(1);
    expect(d.campaigns.find((c) => c.channel === "app_store")!.metrics.spend.reasons).toEqual(["not_paid"]);
  });

  it("warns when a campaign has spend but nothing attributed under that name", () => {
    const d = buildAcquisitionDashboard(campaignInput({ spend: [{ source: "tiktok", campaign: "Launch-Oct", currency: "SAR", origin: "import", amount: 140 }] }));
    expect(d.warnings.find((w) => w.id === "campaign_spend_unmatched")?.params).toEqual({ n: 1 });
  });

  it("keeps the top campaigns and says how many are left out", () => {
    const counts = Array.from({ length: MAX_CAMPAIGNS + 7 }, (_, i) => ({ ...tiktok, campaign: `c${i}`, installs: i + 1, modeled: 0, users: i + 1, activated: 0 }));
    const d = buildAcquisitionDashboard(input({ campaignCounts: counts, spend: [] }));
    expect(d.campaigns).toHaveLength(MAX_CAMPAIGNS);
    expect(d.campaignsOmitted).toBe(7);
    expect(d.campaigns[0].campaign).toBe(`c${MAX_CAMPAIGNS + 6}`);
  });
});
