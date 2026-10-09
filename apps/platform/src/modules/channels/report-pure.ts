/**
 * Channel performance from grouped database rows (see ./report.ts for the
 * queries). Pure, so the classification, coverage and reconciliation
 * arithmetic is unit-tested in report-pure.test.ts without a database.
 */
import { classifyAttribution, evidenceOf, EVIDENCE, type ClassifyContext, type Evidence } from "./classify";
import { costPer, reconcileSpend, type SpendEntry, type SpendIssue } from "./reconcile";
import { channelInfo, type ChannelGroup } from "./registry";

export type CreditModel = "last_touch" | "first_touch";

/** The attribution columns every grouped row carries. */
export interface TouchKey {
  source: string | null;
  medium: string | null;
  network: string | null;
  match_type: string;
  match_key: string | null;
}

export interface AttributionRow extends TouchKey { kind: "install" | "reinstall" | "re_engagement"; n: number; ios: number }
export interface ClickRow { source: string | null; medium: string | null; network: string | null; n: number }
export interface CohortRow extends TouchKey {
  people: number;
  activated: number;
  d1_eligible: number; d1: number;
  d7_eligible: number; d7: number;
  d30_eligible: number; d30: number;
}
/** Conversions credited under the chosen model; `credited` false = no install on record for the person. */
export interface ConversionRow extends TouchKey { credited: boolean; kind: "signup" | "purchase" | "other"; currency: string | null; n: number; revenue: number }

export interface Freshness {
  lastClickAt: Date | null;
  lastAttributionAt: Date | null;
  lastProcessedAt: Date | null;
  lastConversionAt: Date | null;
  lastSpendDay: string | null;
  lastSpendSavedAt: Date | null;
}

export interface ChannelReportInput {
  model: CreditModel;
  classify: ClassifyContext;
  attributions: AttributionRow[];
  clicks: ClickRow[];
  /** Null when the growth model is off (activation and retention aren't measured). */
  cohort: CohortRow[];
  growthMeasured: boolean;
  conversions: ConversionRow[];
  spend: SpendEntry[];
  /** Conversions in the range processed before first-touch recording (rule C3). */
  firstTouchFallback: number;
  /** SKAdNetwork / AdAttributionKit postbacks in the range (provider-reported, rule R2). */
  providerReported: number;
  freshness: Freshness;
}

export interface Money { currency: string; amount: number }
export interface Retention { day: 1 | 7 | 30; eligible: number; retained: number }

export interface ChannelPerformance {
  key: string;
  label: string;
  group: ChannelGroup;
  builtIn: boolean;
  clicks: number;
  installs: number;
  reinstalls: number;
  reengagements: number;
  /** Installs + reinstalls by how they were matched. */
  evidence: Record<Evidence, number>;
  newUsers: number;
  activated: number | null;
  retention: Retention[] | null;
  signups: number;
  purchases: number;
  conversions: number;
  revenue: Money[];
  spend: Money[];
  /** Spend ÷ installs (incl. reinstalls), per spend currency. */
  cpi: Money[];
  /** Spend ÷ purchases, per spend currency. */
  cpa: Money[];
}

export interface ChannelReport {
  model: CreditModel;
  channels: ChannelPerformance[];
  totals: Omit<ChannelPerformance, "key" | "label" | "group" | "builtIn" | "cpi" | "cpa" | "retention" | "activated"> & { activated: number | null; retention: Retention[] | null };
  coverage: {
    /** Installs + reinstalls in the range. */
    installs: number;
    /** With any touch: deterministic + observed + modeled. */
    attributed: number;
    unattributed: number;
    /** Unattributed iOS installs (paid iOS installs without a click id land here). */
    iosUnattributed: number;
    conversions: number;
    /** Conversions whose person has an install on record. */
    conversionsCredited: number;
    firstTouchFallback: number;
    providerReported: number;
    growthMeasured: boolean;
  };
  spendIssues: SpendIssue[];
  freshness: Freshness;
}

const emptyEvidence = (): Record<Evidence, number> => Object.fromEntries(EVIDENCE.map((e) => [e, 0])) as Record<Evidence, number>;

function blank(key: string, ctx: ClassifyContext): ChannelPerformance {
  const info = channelInfo(key, ctx.customChannels ?? []);
  return {
    key, label: info.label, group: info.group, builtIn: info.builtIn, clicks: 0, installs: 0, reinstalls: 0, reengagements: 0, evidence: emptyEvidence(),
    newUsers: 0, activated: null, retention: null, signups: 0, purchases: 0, conversions: 0, revenue: [], spend: [], cpi: [], cpa: [],
  };
}

function addMoney(list: Money[], currency: string, amount: number) {
  const m = list.find((x) => x.currency === currency);
  if (m) m.amount = Math.round((m.amount + amount) * 100) / 100;
  else list.push({ currency, amount: Math.round(amount * 100) / 100 });
}

export function buildChannelReport(input: ChannelReportInput): ChannelReport {
  const ctx = input.classify;
  const channels = new Map<string, ChannelPerformance>();
  const at = (key: string) => {
    if (!channels.has(key)) channels.set(key, blank(key, ctx));
    return channels.get(key)!;
  };
  const cache = new Map<string, string>();
  const channelOf = (r: TouchKey) => {
    const k = [r.source, r.medium, r.network, r.match_type, r.match_key].join("\u0000");
    if (!cache.has(k)) cache.set(k, classifyAttribution(r, ctx).channel);
    return cache.get(k)!;
  };

  let iosUnattributed = 0;
  for (const r of input.attributions) {
    const key = channelOf(r);
    const c = at(key);
    if (r.kind === "re_engagement") {
      c.reengagements += r.n;
      continue;
    }
    if (r.kind === "install") c.installs += r.n;
    else c.reinstalls += r.n;
    c.evidence[evidenceOf(r.match_type, r.match_key)] += r.n;
    if (key === "unattributed") iosUnattributed += r.ios;
  }
  for (const r of input.clicks) at(channelOf({ ...r, match_type: "deterministic", match_key: null })).clicks += r.n;
  for (const r of input.cohort) {
    const c = at(channelOf(r));
    c.newUsers += r.people;
    if (input.growthMeasured) {
      c.activated = (c.activated ?? 0) + r.activated;
      c.retention ??= [{ day: 1, eligible: 0, retained: 0 }, { day: 7, eligible: 0, retained: 0 }, { day: 30, eligible: 0, retained: 0 }];
      c.retention[0].eligible += r.d1_eligible; c.retention[0].retained += r.d1;
      c.retention[1].eligible += r.d7_eligible; c.retention[1].retained += r.d7;
      c.retention[2].eligible += r.d30_eligible; c.retention[2].retained += r.d30;
    }
  }
  let conversions = 0;
  let credited = 0;
  for (const r of input.conversions) {
    const c = at(r.credited ? channelOf(r) : "unattributed");
    c.conversions += r.n;
    conversions += r.n;
    if (r.credited) credited += r.n;
    if (r.kind === "signup") c.signups += r.n;
    if (r.kind === "purchase") c.purchases += r.n;
    if (r.currency && r.revenue) addMoney(c.revenue, r.currency, r.revenue);
  }
  const spendChannel = (source: string) => channelOf({ source, medium: null, network: null, match_type: "reported", match_key: null });
  const spend = reconcileSpend(input.spend, spendChannel);
  for (const [key, byCurrency] of spend.byChannel) {
    const c = at(key);
    for (const [currency, amount] of byCurrency) addMoney(c.spend, currency, amount);
    c.cpi = costPer(byCurrency, c.installs + c.reinstalls);
    c.cpa = costPer(byCurrency, c.purchases);
  }
  for (const c of channels.values()) {
    c.revenue.sort((a, b) => a.currency.localeCompare(b.currency));
    c.spend.sort((a, b) => a.currency.localeCompare(b.currency));
  }

  const list = [...channels.values()].sort(
    (a, b) => Number(a.group === "none") - Number(b.group === "none") || b.installs + b.reinstalls - (a.installs + a.reinstalls) || b.conversions - a.conversions || b.clicks - a.clicks || a.key.localeCompare(b.key),
  );
  const sum = (f: (c: ChannelPerformance) => number) => list.reduce((s, c) => s + f(c), 0);
  const evidence = emptyEvidence();
  for (const c of list) for (const e of EVIDENCE) evidence[e] += c.evidence[e];
  const revenue: Money[] = [];
  const spendTotal: Money[] = [];
  for (const c of list) {
    for (const m of c.revenue) addMoney(revenue, m.currency, m.amount);
    for (const m of c.spend) addMoney(spendTotal, m.currency, m.amount);
  }
  const retention = input.growthMeasured
    ? ([1, 7, 30] as const).map((day, i) => ({ day, eligible: sum((c) => c.retention?.[i].eligible ?? 0), retained: sum((c) => c.retention?.[i].retained ?? 0) }))
    : null;
  const installs = sum((c) => c.installs + c.reinstalls);
  return {
    model: input.model,
    channels: list,
    totals: {
      clicks: sum((c) => c.clicks), installs: sum((c) => c.installs), reinstalls: sum((c) => c.reinstalls), reengagements: sum((c) => c.reengagements),
      evidence, newUsers: sum((c) => c.newUsers), activated: input.growthMeasured ? sum((c) => c.activated ?? 0) : null, retention,
      signups: sum((c) => c.signups), purchases: sum((c) => c.purchases), conversions, revenue: revenue.sort((a, b) => a.currency.localeCompare(b.currency)),
      spend: spendTotal.sort((a, b) => a.currency.localeCompare(b.currency)),
    },
    coverage: {
      installs,
      attributed: evidence.deterministic + evidence.observed + evidence.modeled + evidence.provider_reported,
      unattributed: evidence.none,
      iosUnattributed,
      conversions,
      conversionsCredited: credited,
      firstTouchFallback: input.model === "first_touch" ? input.firstTouchFallback : 0,
      providerReported: input.providerReported,
      growthMeasured: input.growthMeasured,
    },
    spendIssues: spend.issues,
    freshness: input.freshness,
  };
}
