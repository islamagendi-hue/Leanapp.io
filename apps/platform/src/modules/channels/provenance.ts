/**
 * Acquisition dashboard: every metric by source (channel) and campaign, each
 * labelled with where it comes from, plus the coverage warnings that say what
 * is missing. Pure and client-safe (unit-tested in provenance.test.ts); the
 * rows come from modules/channels/report.ts (channel level) and
 * ./provenance-data.ts (campaign level, spend origin, ad integrations).
 *
 * Provenance (docs/channels.md "Provenance"):
 *   observed     LeanApp counted it from its own event stream: users, installs,
 *                sign-ups, activation, purchases, revenue
 *   imported     from outside the event stream: ad spend, imported from an ad
 *                account or entered by hand / CSV (the detail says which)
 *   modeled      inferred, not observed: installs matched probabilistically
 *                (opt-in Android device-signal match)
 *   unavailable  LeanApp has no data for it (growth model off, no spend for a
 *                paid channel, no revenue events, no permission to see spend)
 *
 * A derived metric (CAC, ROAS) takes the weakest label of its inputs
 * (observed < imported < modeled < unavailable), and is marked incomplete,
 * with the reasons, whenever the spend or conversion data under it is partial.
 * Nothing is converted across currencies.
 */
import { msg } from "@/i18n/translate";
import { classifyAttribution, type ClassifyContext } from "./classify";
import { channelInfo, type ChannelGroup } from "./registry";
import type { ChannelReport, ConversionRow, Money, TouchKey } from "./report-pure";

export const PROVENANCE = ["observed", "imported", "modeled", "unavailable"] as const;
export type Provenance = (typeof PROVENANCE)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  observed: msg("Observed"),
  imported: msg("Imported"),
  modeled: msg("Modeled"),
  unavailable: msg("Unavailable"),
};

export const PROVENANCE_HELP: Record<Provenance, string> = {
  observed: msg("Observed: counted by LeanApp from your app's own events."),
  imported: msg("Imported: from outside LeanApp's event stream, from an ad account's cost import or entered by hand on Ad spend."),
  modeled: msg("Modeled: inferred, not observed, such as installs matched on device signals."),
  unavailable: msg("Unavailable: LeanApp has no data for it. The reason is shown with the number."),
};

/** Why a metric is unavailable or incomplete. */
export type GapReason =
  | "growth_not_measured"
  | "no_spend_access"
  | "no_spend"
  | "not_paid"
  | "no_users"
  | "no_revenue_events"
  | "currency_mismatch"
  | "spend_import_failing"
  | "spend_import_stale"
  | "paid_channels_without_spend"
  | "unattributed_users"
  | "unattributed_conversions";

export const GAP_LABELS: Record<GapReason, string> = {
  growth_not_measured: msg("Growth model is off"),
  no_spend_access: msg("Spend needs the analytics permission"),
  no_spend: msg("No spend for this paid channel"),
  not_paid: msg("No spend expected"),
  no_users: msg("No new users"),
  no_revenue_events: msg("No revenue events received"),
  currency_mismatch: msg("Spend and revenue in different currencies"),
  spend_import_failing: msg("Cost import is failing"),
  spend_import_stale: msg("Cost import is behind"),
  paid_channels_without_spend: msg("Some paid channels have no spend"),
  unattributed_users: msg("Some installs are unattributed"),
  unattributed_conversions: msg("Some conversions have no install on record"),
};

export interface Metric<V> {
  value: V;
  provenance: Provenance;
  /** False when the number rests on partial data (it is shown, marked incomplete). */
  complete: boolean;
  reasons: GapReason[];
}

export interface Ratio { currency: string; value: number }
export type SpendOrigin = "manual" | "import";

export interface DashboardMetrics {
  users: Metric<number>;
  /** Installs + reinstalls; `modeled` of them were matched probabilistically. */
  installs: Metric<number> & { modeled: number };
  signups: Metric<number>;
  activated: Metric<number | null>;
  purchases: Metric<number>;
  revenue: Metric<Money[] | null>;
  /** `origins`: where the spend came from (an ad account's cost import, entered by hand). */
  spend: Metric<Money[] | null> & { origins: SpendOrigin[] };
  /** Spend ÷ new users, per spend currency. */
  cac: Metric<Money[] | null>;
  /** Revenue ÷ spend in the same currency. */
  roas: Metric<Ratio[] | null>;
}

export type MetricId = keyof DashboardMetrics;
export const METRIC_IDS: MetricId[] = ["users", "installs", "signups", "activated", "purchases", "revenue", "spend", "cac", "roas"];

export interface DashboardRow {
  key: string;
  channel: string;
  label: string;
  group: ChannelGroup;
  /** Campaign rows: the campaign (null = no campaign on the touch); `wholeSource` = spend entered for the whole source. */
  campaign?: string | null;
  wholeSource?: boolean;
  metrics: DashboardMetrics;
}

export interface CoverageWarning {
  id:
    | "spend_hidden" | "no_spend" | "no_cost_import" | "paid_without_spend" | "import_failing" | "import_unverified" | "import_stale"
    | "reporting_without_cost_import" | "unattributed_installs" | "unattributed_conversions" | "no_revenue_events" | "growth_not_measured"
    | "first_touch_fallback" | "campaign_spend_unmatched" | "provider_reported";
  severity: "warn" | "info";
  text: string;
  params: Record<string, string | number>;
  /** Channel labels (translation keys) the page translates and joins into the `channels` parameter. */
  labels?: string[];
  /** Where to fix it (the page maps it to a link). */
  action?: "spend" | "integrations" | "growth" | "attribution";
}

/** Campaign-level counts by touch (provenance-data.ts). */
export interface CampaignCountRow extends TouchKey { campaign: string | null; installs: number; modeled: number; users: number; activated: number }
export interface CampaignConversionRow extends ConversionRow { campaign: string | null }
/** Spend after rule S1 (whole-source rows left out on days with campaign rows), by source, campaign, currency and origin. */
export interface SpendOriginRow { source: string; campaign: string; currency: string; origin: SpendOrigin; amount: number }

/** One ad provider's cost import, for coverage warnings. */
export interface SpendImportState {
  provider: string;
  providerName: string;
  /** The Ad spend source label it writes (lower case). */
  source: string;
  reportingEnabled: boolean;
  reportingStatus: string;
  spendEnabled: boolean;
  spendStatus: string;
  /** Last day fully imported. */
  freshThrough: string | null;
}

export interface DashboardInput {
  report: ChannelReport;
  classify: ClassifyContext;
  range: { from: string; to: string };
  /** Today in the app's timezone (YYYY-MM-DD). */
  today: string;
  /** False when the viewer can't see spend (analytics.read). */
  spendAccess: boolean;
  spend: SpendOriginRow[];
  campaignCounts: CampaignCountRow[];
  campaignConversions: CampaignConversionRow[];
  /** Null when the viewer can't see integrations (integrations.read): no integration warnings then. */
  imports: SpendImportState[] | null;
}

export interface AcquisitionDashboard {
  totals: DashboardMetrics;
  channels: DashboardRow[];
  campaigns: DashboardRow[];
  /** Campaign rows left out (only the top MAX_CAMPAIGNS are kept). */
  campaignsOmitted: number;
  warnings: CoverageWarning[];
  coverage: {
    /** Paid channels with installs, clicks or conversions in the range, and how many of them have spend. */
    paidChannels: number;
    paidChannelsWithSpend: number;
    installs: number;
    attributedInstalls: number;
    conversions: number;
    creditedConversions: number;
  };
}

export const MAX_CAMPAIGNS = 50;
/** Ad networks restate the last days; an import this many days behind the range end is still current. */
export const IMPORT_LAG_DAYS = 2;

const RANK: Record<Provenance, number> = { observed: 0, imported: 1, modeled: 2, unavailable: 3 };
/** The weakest of the inputs' labels. */
export const weakest = (...p: Provenance[]): Provenance => p.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "observed");

const r2 = (n: number) => Math.round(n * 100) / 100;
const uniq = <T,>(a: T[]) => [...new Set(a)];
const ok = <V,>(value: V, provenance: Provenance = "observed"): Metric<V> => ({ value, provenance, complete: true, reasons: [] });
const gap = <V,>(value: V, reasons: GapReason[]): Metric<V> => ({ value, provenance: "unavailable", complete: false, reasons });

function addMoney(list: Money[], currency: string, amount: number) {
  const m = list.find((x) => x.currency === currency);
  if (m) m.amount = r2(m.amount + amount);
  else list.push({ currency, amount: r2(amount) });
}
const sortMoney = (l: Money[]) => l.sort((a, b) => a.currency.localeCompare(b.currency));

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** What a row's spend rests on: problems with the cost imports that feed its channel. */
interface SpendHealth { failing: boolean; stale: boolean }

interface RowFacts {
  group: ChannelGroup;
  users: number;
  installs: number;
  modeled: number;
  signups: number;
  activated: number | null;
  purchases: number;
  revenue: Money[];
  spend: Money[];
  origins: SpendOrigin[];
  /** Installs, clicks or conversions: activity that a paid channel should have spend for. */
  active: boolean;
}

interface Context {
  growthMeasured: boolean;
  spendAccess: boolean;
  /** Any conversion ever processed in the environment (revenue events arrive). */
  revenueData: boolean;
  unattributedInstalls: boolean;
  unattributedConversions: boolean;
}

/**
 * The metrics of one row. `scope` "row" is a channel or campaign: unattributed
 * installs and conversions make its CAC / ROAS incomplete (some of its users
 * or revenue may be among them). `scope` "total" adds them all up, so they don't.
 */
export function rowMetrics(f: RowFacts, health: SpendHealth, c: Context, scope: "row" | "total", extra: GapReason[] = []): DashboardMetrics {
  const installs = { ...ok(f.installs, f.installs > 0 && f.modeled === f.installs ? "modeled" : "observed"), modeled: f.modeled };
  const activated = c.growthMeasured ? ok<number | null>(f.activated ?? 0) : gap<number | null>(null, ["growth_not_measured"]);
  const revenue = c.revenueData ? ok<Money[] | null>(sortMoney([...f.revenue])) : gap<Money[] | null>(null, ["no_revenue_events"]);

  // Spend: imported (or entered by hand); unavailable without permission or without spend.
  let spend: DashboardMetrics["spend"];
  const spendGaps: GapReason[] = [];
  if (health.failing) spendGaps.push("spend_import_failing");
  if (health.stale) spendGaps.push("spend_import_stale");
  spendGaps.push(...extra);
  if (!c.spendAccess) spend = { ...gap<Money[] | null>(null, ["no_spend_access"]), origins: [] };
  else if (f.spend.length) spend = { value: sortMoney([...f.spend]), provenance: "imported", complete: spendGaps.length === 0, reasons: spendGaps, origins: f.origins };
  else if (f.group === "paid" || scope === "total") spend = { ...gap<Money[] | null>(null, uniq<GapReason>(["no_spend", ...spendGaps])), origins: [] };
  else spend = { ...gap<Money[] | null>(null, ["not_paid"]), origins: [] };

  // CAC: spend ÷ new users.
  let cac: Metric<Money[] | null>;
  if (spend.value === null) cac = gap(null, spend.reasons);
  else if (f.users <= 0) cac = gap(null, uniq<GapReason>(["no_users", ...spend.reasons]));
  else {
    const reasons = uniq<GapReason>([...spend.reasons, ...(scope === "row" && c.unattributedInstalls ? (["unattributed_users"] as const) : [])]);
    cac = {
      value: spend.value.filter((m) => m.amount > 0).map((m) => ({ currency: m.currency, amount: r2(m.amount / f.users) })),
      provenance: weakest("observed", spend.provenance),
      complete: reasons.length === 0,
      reasons,
    };
    if (!cac.value?.length) cac = gap(null, uniq<GapReason>(["no_spend", ...spend.reasons]));
  }

  // ROAS: revenue ÷ spend, same currency only.
  let roas: Metric<Ratio[] | null>;
  if (spend.value === null) roas = gap(null, spend.reasons);
  else if (revenue.value === null) roas = gap(null, revenue.reasons);
  else {
    const spent = spend.value.filter((m) => m.amount > 0);
    const rev = new Map(revenue.value.map((m) => [m.currency, m.amount]));
    const values: Ratio[] = [];
    let mismatch = revenue.value.some((m) => m.amount !== 0 && !spent.some((s) => s.currency === m.currency));
    for (const s of spent) {
      if (!rev.has(s.currency) && rev.size > 0) {
        mismatch = true;
        continue;
      }
      values.push({ currency: s.currency, value: r2((rev.get(s.currency) ?? 0) / s.amount) });
    }
    const reasons = uniq<GapReason>([
      ...spend.reasons,
      ...(mismatch ? (["currency_mismatch"] as const) : []),
      ...(scope === "row" && c.unattributedConversions ? (["unattributed_conversions"] as const) : []),
    ]);
    roas = values.length
      ? { value: values, provenance: weakest("observed", spend.provenance), complete: reasons.length === 0, reasons }
      : gap(null, reasons.length ? reasons : ["no_spend"]);
  }

  return {
    users: ok(f.users),
    installs,
    signups: ok(f.signups),
    activated,
    purchases: ok(f.purchases),
    revenue,
    spend,
    cac,
    roas,
  };
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function buildAcquisitionDashboard(input: DashboardInput): AcquisitionDashboard {
  const { report, classify } = input;
  const cov = report.coverage;
  const cache = new Map<string, string>();
  const channelOf = (r: TouchKey) => {
    const k = [r.source, r.medium, r.network, r.match_type, r.match_key].join("\u0000");
    if (!cache.has(k)) cache.set(k, classifyAttribution(r, classify).channel);
    return cache.get(k)!;
  };
  const spendChannel = (source: string) => channelOf({ source: source.toLowerCase(), medium: null, network: null, match_type: "reported", match_key: null });

  const ctx: Context = {
    growthMeasured: cov.growthMeasured,
    spendAccess: input.spendAccess,
    revenueData: report.freshness.lastConversionAt !== null,
    unattributedInstalls: cov.unattributed > 0,
    unattributedConversions: cov.conversionsCredited < cov.conversions,
  };

  // Cost imports, by the channel they write spend for.
  // The range end, or (for a range reaching today) the last day networks have settled.
  const settled = addDays(input.today, -IMPORT_LAG_DAYS);
  const expectedThrough = input.range.to < settled ? input.range.to : settled;
  const imports = (input.imports ?? []).map((i) => ({
    ...i,
    channel: spendChannel(i.source),
    failing: i.spendEnabled && (i.spendStatus === "error" || i.spendStatus === "credentials_missing" || (i.reportingStatus === "error" && i.reportingEnabled)),
    stale: i.spendEnabled && i.spendStatus !== "error" && (i.freshThrough === null || i.freshThrough < expectedThrough),
  }));
  const healthOf = (channel: string | null): SpendHealth => {
    const list = imports.filter((i) => channel === null || i.channel === channel);
    return { failing: list.some((i) => i.failing), stale: list.some((i) => i.stale) };
  };

  // Spend origin per channel.
  const originsByChannel = new Map<string, Set<SpendOrigin>>();
  for (const s of input.spend) {
    if (s.amount <= 0) continue;
    const ch = spendChannel(s.source);
    originsByChannel.set(ch, (originsByChannel.get(ch) ?? new Set()).add(s.origin));
  }
  const allOrigins = uniq(input.spend.filter((s) => s.amount > 0).map((s) => s.origin)).sort() as SpendOrigin[];

  // ── Channels ──
  const channels: DashboardRow[] = report.channels.map((c) => {
    const facts: RowFacts = {
      group: c.group,
      users: c.newUsers,
      installs: c.installs + c.reinstalls,
      modeled: c.evidence.modeled,
      signups: c.signups,
      activated: c.activated,
      purchases: c.purchases,
      revenue: c.revenue,
      spend: c.spend,
      origins: [...(originsByChannel.get(c.key) ?? [])].sort() as SpendOrigin[],
      active: c.installs + c.reinstalls + c.conversions + c.clicks > 0,
    };
    return { key: c.key, channel: c.key, label: c.label, group: c.group, metrics: rowMetrics(facts, healthOf(c.key), ctx, "row") };
  });

  const paidActive = report.channels.filter((c) => c.group === "paid" && c.installs + c.reinstalls + c.conversions + c.clicks > 0);
  const paidWithoutSpend = paidActive.filter((c) => !c.spend.length);

  // ── Totals ──
  const t = report.totals;
  const totals = rowMetrics(
    {
      group: "paid", users: t.newUsers, installs: t.installs + t.reinstalls, modeled: t.evidence.modeled, signups: t.signups,
      activated: t.activated, purchases: t.purchases, revenue: t.revenue, spend: t.spend, origins: allOrigins, active: true,
    },
    healthOf(null),
    ctx,
    "total",
    input.spendAccess && t.spend.length && paidWithoutSpend.length ? ["paid_channels_without_spend"] : [],
  );

  // ── Campaigns ──
  type Acc = RowFacts & { channel: string; campaign: string | null; wholeSource: boolean };
  const camps = new Map<string, Acc>();
  const campAt = (channel: string, campaign: string | null, wholeSource = false) => {
    const k = [channel, wholeSource ? "\u0001" : campaign === null ? "\u0000" : norm(campaign)].join("\u0002");
    if (!camps.has(k)) {
      const info = channelInfo(channel, classify.customChannels ?? []);
      camps.set(k, {
        channel, campaign: campaign && campaign.trim() ? campaign.trim() : null, wholeSource, group: info.group, users: 0, installs: 0, modeled: 0, signups: 0,
        activated: ctx.growthMeasured ? 0 : null, purchases: 0, revenue: [], spend: [], origins: [], active: false,
      });
    }
    return camps.get(k)!;
  };
  for (const r of input.campaignCounts) {
    const a = campAt(channelOf(r), r.campaign && r.campaign.trim() ? r.campaign : null);
    a.users += r.users;
    a.installs += r.installs;
    a.modeled += r.modeled;
    if (a.activated !== null) a.activated += r.activated;
    if (r.installs > 0) a.active = true;
  }
  for (const r of input.campaignConversions) {
    const a = r.credited ? campAt(channelOf(r), r.campaign && r.campaign.trim() ? r.campaign : null) : campAt("unattributed", null);
    if (r.kind === "signup") a.signups += r.n;
    if (r.kind === "purchase") a.purchases += r.n;
    if (r.currency && r.revenue) addMoney(a.revenue, r.currency, r.revenue);
    if (r.n > 0) a.active = true;
  }
  for (const s of input.spend) {
    if (s.amount <= 0) continue;
    const a = campAt(spendChannel(s.source), s.campaign || null, !s.campaign);
    addMoney(a.spend, s.currency, s.amount);
    if (!a.origins.includes(s.origin)) a.origins.push(s.origin);
  }
  const campaignList = [...camps.values()].sort(
    (a, b) => Number(a.group === "none") - Number(b.group === "none") || b.users - a.users || b.installs - a.installs
      || b.purchases + b.signups - (a.purchases + a.signups) || b.spend.length - a.spend.length || a.channel.localeCompare(b.channel)
      || (a.campaign ?? "").localeCompare(b.campaign ?? ""),
  );
  const campaigns: DashboardRow[] = campaignList.slice(0, MAX_CAMPAIGNS).map((a) => {
    const info = channelInfo(a.channel, classify.customChannels ?? []);
    a.origins.sort();
    return {
      key: `${a.channel}:${a.wholeSource ? "*" : a.campaign ?? ""}`, channel: a.channel, label: info.label, group: info.group, campaign: a.campaign, wholeSource: a.wholeSource,
      metrics: rowMetrics(a, healthOf(a.channel), ctx, "row"),
    };
  });
  // Spend on a campaign nothing was attributed to, while that channel has campaigns without spend: names probably differ.
  const unmatched = campaignList.filter((a) => a.group === "paid" && !a.wholeSource && a.spend.length && a.users + a.installs + a.signups + a.purchases === 0
    && campaignList.some((b) => b.channel === a.channel && !b.wholeSource && !b.spend.length && b.installs > 0));

  // ── Warnings ──
  const warnings: CoverageWarning[] = [];
  const w = (x: CoverageWarning) => warnings.push(x);
  if (!input.spendAccess) {
    w({ id: "spend_hidden", severity: "info", text: msg("Spend, CAC and ROAS are hidden: they need the permission to view analytics."), params: {} });
  } else {
    const anyImport = imports.some((i) => i.spendEnabled);
    if (!t.spend.length) {
      if (input.imports && !anyImport) {
        w({ id: "no_cost_import", severity: "warn", action: "integrations", params: {},
          text: msg("No ad spend in this range and no ad account imports its costs. CAC and ROAS are unavailable until spend is imported or entered on Ad spend.") });
      } else {
        w({ id: "no_spend", severity: "warn", action: "spend", params: {}, text: msg("No ad spend in this range. CAC and ROAS are unavailable until spend is imported or entered on Ad spend.") });
      }
    } else if (paidWithoutSpend.length) {
      w({ id: "paid_without_spend", severity: "warn", action: "spend", params: { n: paidWithoutSpend.length }, labels: paidWithoutSpend.map((c) => c.label),
        text: msg("Paid channels with activity but no spend: {channels}. Their CAC and ROAS are unavailable, and the totals are incomplete.") });
    }
    for (const i of imports) {
      if (i.failing) {
        w({ id: "import_failing", severity: "warn", action: "integrations", params: { provider: i.providerName },
          text: msg("{provider}: cost import is failing or missing credentials. Its spend may be partial; CAC and ROAS on that channel are marked incomplete.") });
      } else if (i.stale) {
        w({ id: "import_stale", severity: "warn", action: "integrations", params: { provider: i.providerName, day: i.freshThrough ?? "—" },
          text: msg("{provider}: costs are imported only up to {day}, before the end of this range. CAC and ROAS on that channel are marked incomplete.") });
      } else if (i.spendEnabled && i.spendStatus === "unverified") {
        w({ id: "import_unverified", severity: "info", action: "integrations", params: { provider: i.providerName },
          text: msg("{provider}: cost import is set up but has not completed a call to the provider yet.") });
      }
      if (i.reportingEnabled && !i.spendEnabled) {
        w({ id: "reporting_without_cost_import", severity: "info", action: "integrations", params: { provider: i.providerName },
          text: msg("{provider}: ad reporting is imported, but cost import into Ad spend is off, so its costs are not used for CAC and ROAS.") });
      }
    }
    if (unmatched.length) {
      w({ id: "campaign_spend_unmatched", severity: "info", action: "spend", params: { n: unmatched.length },
        text: msg("{n} campaigns have spend but no installs or conversions under the same name. Campaign names in Ad spend must match the campaign on your links or UTM parameters.") });
    }
  }
  if (cov.unattributed > 0) {
    w({ id: "unattributed_installs", severity: "warn", action: "attribution", params: { n: cov.unattributed, total: cov.installs, ios: cov.iosUnattributed },
      text: cov.iosUnattributed
        ? msg("{n} of {total} installs are unattributed ({ios} on iOS, where paid installs can't be matched without a click id, SKAdNetwork or Apple Search Ads). Per-channel users and CAC are marked incomplete.")
        : msg("{n} of {total} installs are unattributed. Per-channel users and CAC are marked incomplete.") });
  }
  if (ctx.unattributedConversions) {
    const n = cov.conversions - cov.conversionsCredited;
    w({ id: "unattributed_conversions", severity: "warn", action: "attribution", params: { n, total: cov.conversions },
      text: msg("{n} of {total} conversions have no install on record, so their revenue is on no channel. Per-channel ROAS is marked incomplete.") });
  }
  if (!ctx.revenueData) {
    w({ id: "no_revenue_events", severity: "warn", params: {}, text: msg("No conversion or revenue events have been received yet. Revenue and ROAS are unavailable.") });
  }
  if (!cov.growthMeasured) {
    w({ id: "growth_not_measured", severity: "info", action: "growth", params: {}, text: msg("Activation is unavailable: turn on the growth model to measure it.") });
  }
  if (cov.firstTouchFallback > 0) {
    w({ id: "first_touch_fallback", severity: "info", params: { n: cov.firstTouchFallback },
      text: msg("{n} conversions were processed before first-touch recording and use their last touch here.") });
  }
  if (cov.providerReported > 0) {
    w({ id: "provider_reported", severity: "info", action: "attribution", params: { n: cov.providerReported },
      text: msg("{n} SKAdNetwork / AdAttributionKit postbacks are provider-reported and aggregate: shown on Attribution, never added here.") });
  }
  warnings.sort((a, b) => Number(a.severity === "info") - Number(b.severity === "info"));

  return {
    totals,
    channels,
    campaigns,
    campaignsOmitted: Math.max(campaignList.length - MAX_CAMPAIGNS, 0),
    warnings,
    coverage: {
      paidChannels: paidActive.length,
      paidChannelsWithSpend: paidActive.length - paidWithoutSpend.length,
      installs: cov.installs,
      attributedInstalls: cov.attributed,
      conversions: cov.conversions,
      creditedConversions: cov.conversionsCredited,
    },
  };
}
