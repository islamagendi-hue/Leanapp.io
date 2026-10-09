/**
 * Reconciliation rules for channel reporting: how spend, conversions and
 * revenue are counted so nothing is counted twice. Pure; unit-tested in
 * reconcile.test.ts. The rules (docs/channels.md "Reconciliation"):
 *
 * Spend
 *   S1  A day's spend for a source and currency entered both for the whole source (campaign '')
 *       and per campaign: the campaign rows are used and the whole-source row is left out
 *       (reported as an issue with the amount left out).
 *   S2  Two source spellings that land on the same channel (facebook / meta) with the same day,
 *       campaign, currency and amount: counted once (an exact duplicate) and reported. Different
 *       amounts are both counted: Facebook and Instagram spend are both Meta.
 *   S3  Amounts are never converted or added across currencies.
 *   S4  Spend on a channel with no source behind it (direct, unknown, unattributed) is kept
 *       visible on that row, never spread over other channels.
 * Conversions
 *   C1  One conversion per processed event (attribution_conversions is unique per event row);
 *       ingestion drops repeated event ids, so a retried SDK batch is not a second conversion.
 *   C2  Each conversion is credited to exactly one channel per model; first-touch and last-touch
 *       totals are two views of the same conversions and are never added together.
 *   C3  Conversions processed before first-touch recording (migration 0034) use their last touch
 *       in the first-touch view, and the report says how many.
 * Revenue
 *   R1  Revenue is summed per currency; refunds are negative.
 *   R2  Provider-reported numbers (SKAdNetwork / AdAttributionKit postbacks, ad platform reports)
 *       are shown next to LeanApp's own counts, never added to them.
 */

export interface SpendEntry {
  day: string;
  source: string;
  /** '' = the whole source. */
  campaign: string;
  currency: string;
  amount: number;
}

export type SpendIssue =
  | { rule: "S1"; day: string; source: string; currency: string; excluded: number }
  | { rule: "S2"; day: string; channel: string; campaign: string; currency: string; sources: string[]; excluded: number };

export interface ReconciledSpend {
  /** channel → currency → amount. */
  byChannel: Map<string, Map<string, number>>;
  issues: SpendIssue[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function reconcileSpend(rows: readonly SpendEntry[], channelOf: (source: string) => string): ReconciledSpend {
  const issues: SpendIssue[] = [];
  // S1: whole-source rows on days that also have campaign rows.
  const withCampaigns = new Set(rows.filter((r) => r.campaign).map((r) => `${r.day}\u0000${r.source.toLowerCase()}\u0000${r.currency}`));
  const kept: SpendEntry[] = [];
  for (const r of rows) {
    if (!r.campaign && withCampaigns.has(`${r.day}\u0000${r.source.toLowerCase()}\u0000${r.currency}`)) {
      if (r.amount) issues.push({ rule: "S1", day: r.day, source: r.source, currency: r.currency, excluded: r2(r.amount) });
      continue;
    }
    kept.push(r);
  }
  // S2: several spellings of one channel on the same day, campaign and currency.
  const groups = new Map<string, (SpendEntry & { channel: string })[]>();
  for (const r of kept) {
    const channel = channelOf(r.source);
    const k = [r.day, channel, r.campaign.toLowerCase(), r.currency].join("\u0000");
    groups.set(k, [...(groups.get(k) ?? []), { ...r, channel }]);
  }
  const byChannel = new Map<string, Map<string, number>>();
  const add = (channel: string, currency: string, amount: number) => {
    const m = byChannel.get(channel) ?? new Map<string, number>();
    m.set(currency, r2((m.get(currency) ?? 0) + amount));
    byChannel.set(channel, m);
  };
  for (const g of groups.values()) {
    const sources = [...new Set(g.map((r) => r.source.toLowerCase()))];
    if (sources.length < 2) {
      for (const r of g) add(r.channel, r.currency, r.amount);
      continue;
    }
    const duplicate = new Set(g.map((r) => r.amount)).size === 1;
    if (!duplicate) {
      for (const r of g) add(r.channel, r.currency, r.amount);
      continue;
    }
    add(g[0].channel, g[0].currency, g[0].amount);
    issues.push({ rule: "S2", day: g[0].day, channel: g[0].channel, campaign: g[0].campaign, currency: g[0].currency, sources: sources.sort(), excluded: r2(g[0].amount * (g.length - 1)) });
  }
  issues.sort((a, b) => a.day.localeCompare(b.day) || a.rule.localeCompare(b.rule));
  return { byChannel, issues };
}

/** Cost per result, per spend currency; null without spend or results. */
export function costPer(spend: Map<string, number> | undefined, results: number): { currency: string; amount: number }[] {
  if (!spend || results <= 0) return [];
  return [...spend.entries()].filter(([, v]) => v > 0).map(([currency, v]) => ({ currency, amount: r2(v / results) })).sort((a, b) => a.currency.localeCompare(b.currency));
}
