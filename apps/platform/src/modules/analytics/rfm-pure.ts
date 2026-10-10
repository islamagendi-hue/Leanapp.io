/**
 * RFM segments (Retention → RFM segments; queries in ./rfm.ts). Pure, so the
 * scoring and the segment map are unit tested, and the audience compiler
 * (modules/audiences/definition.ts) builds the same scoring in SQL.
 *
 * Over a window of the last N days, in one currency:
 * - A customer is a person with at least one purchase (a revenue transaction
 *   that isn't a refund, by the Revenue report's rules) in that currency.
 * - Recency: whole days (24 hours) since their last purchase.
 * - Frequency: their purchases.
 * - Monetary: their net revenue (purchases minus refunds), to the cent.
 * Each is scored 1 to 5 by quintile among the window's customers, 5 best
 * (most recent, most purchases, most revenue), from the value's percent rank:
 * 1 + ⌊5 × worse ÷ (customers − 1)⌋, at most 5, where `worse` counts the
 * customers with a strictly worse value. Ties share the lower score, so
 * people who bought once always get frequency 1 (however many there are),
 * and when everyone has the same value everyone gets 1, as does a single
 * customer.
 * The segment comes from R and FM = (F + M) ÷ 2 rounded half up, on the
 * grid below: every one of the 25 cells has exactly one segment.
 */
import { msg } from "@/i18n/translate";
import type { AudienceNode } from "@/modules/audiences/definition";

/** Windows offered (days back from now). */
export const RFM_WINDOWS = [30, 90, 180, 365] as const;
export type RfmWindow = (typeof RFM_WINDOWS)[number];
export const DEFAULT_RFM_WINDOW: RfmWindow = 365;

export function rfmWindow(v: unknown): RfmWindow {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (RFM_WINDOWS as readonly number[]).includes(n) ? (n as RfmWindow) : DEFAULT_RFM_WINDOW;
}

/** The segments, best first (the order of the page and the legend). */
export const RFM_SEGMENTS = [
  "champions", "loyal", "potential_loyalists", "new_customers", "promising", "need_attention",
  "about_to_sleep", "at_risk", "cant_lose", "hibernating", "lost",
] as const;
export type RfmSegment = (typeof RFM_SEGMENTS)[number];

export const SEGMENT_LABELS: Record<RfmSegment, string> = {
  champions: msg("Champions"),
  loyal: msg("Loyal"),
  potential_loyalists: msg("Potential loyalists"),
  new_customers: msg("New customers"),
  promising: msg("Promising"),
  need_attention: msg("Need attention"),
  about_to_sleep: msg("About to sleep"),
  at_risk: msg("At risk"),
  cant_lose: msg("Can't lose them"),
  hibernating: msg("Hibernating"),
  lost: msg("Lost"),
};

/** Who they are, in a line. */
export const SEGMENT_HINTS: Record<RfmSegment, string> = {
  champions: msg("Bought recently, buy often and spend the most."),
  loyal: msg("Buy often and spend well, though not always the most recently."),
  potential_loyalists: msg("Recent customers with a few purchases. Could become loyal."),
  new_customers: msg("Bought very recently, for the first time or close to it."),
  promising: msg("Recent, but haven't bought much yet."),
  need_attention: msg("Average on all three. Slipping without a nudge."),
  about_to_sleep: msg("Haven't bought for a while and didn't buy much."),
  at_risk: msg("Used to buy often or spend well, but not lately."),
  cant_lose: msg("Your biggest customers once, gone quiet for a long time."),
  hibernating: msg("Last bought long ago, little and rarely."),
  lost: msg("The least recent, with the fewest purchases and least revenue."),
};

/** GRID[R − 1][FM − 1]. */
const GRID: RfmSegment[][] = [
  /* R1 */ ["lost", "lost", "at_risk", "at_risk", "cant_lose"],
  /* R2 */ ["hibernating", "hibernating", "at_risk", "at_risk", "cant_lose"],
  /* R3 */ ["about_to_sleep", "about_to_sleep", "need_attention", "loyal", "loyal"],
  /* R4 */ ["promising", "potential_loyalists", "potential_loyalists", "loyal", "loyal"],
  /* R5 */ ["new_customers", "potential_loyalists", "potential_loyalists", "champions", "champions"],
];

export type Score = 1 | 2 | 3 | 4 | 5;

/** The quintile score of a value with `worse` customers strictly below it, among `n`. */
export function quintile(worse: number, n: number): Score {
  return Math.min(5, 1 + Math.floor((5 * worse) / Math.max(n - 1, 1))) as Score;
}

/** Scores of `values` (same order), 5 for the best; `higherIsBetter` false for recency (fewer days is better). */
export function quintileScores(values: number[], higherIsBetter = true): Score[] {
  const n = values.length;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Worse-to-better order of the distinct values, and how many customers are below each.
  const distinct = [...counts.keys()].sort((a, b) => (higherIsBetter ? a - b : b - a));
  const worse = new Map<number, number>();
  let below = 0;
  for (const v of distinct) {
    worse.set(v, below);
    below += counts.get(v)!;
  }
  return values.map((v) => quintile(worse.get(v)!, n));
}

/** F and M combined: their average, rounded half up. */
export const fmScore = (f: number, m: number): Score => Math.floor((f + m + 1) / 2) as Score;

export const segmentOf = (r: Score, fm: Score): RfmSegment => GRID[r - 1][fm - 1];

export interface RfmCustomer {
  /** user_id, or `anon:` + anonymous id. */
  person: string;
  /** Days since the last purchase. */
  recency: number;
  frequency: number;
  /** Net revenue in the currency. */
  monetary: number;
}

export interface ScoredCustomer extends RfmCustomer {
  r: Score;
  f: Score;
  m: Score;
  segment: RfmSegment;
}

export function scoreCustomers(customers: RfmCustomer[]): ScoredCustomer[] {
  const r = quintileScores(customers.map((c) => c.recency), false);
  const f = quintileScores(customers.map((c) => c.frequency));
  const m = quintileScores(customers.map((c) => c.monetary));
  return customers.map((c, i) => ({ ...c, r: r[i], f: f[i], m: m[i], segment: segmentOf(r[i], fmScore(f[i], m[i])) }));
}

export interface SegmentSummary {
  segment: RfmSegment;
  customers: number;
  /** Net revenue of the segment's customers. */
  revenue: number;
  /** Share of all customers (0–1). */
  customerShare: number;
  /** Share of the net revenue of all customers (0–1); null when that total isn't above zero. */
  revenueShare: number | null;
  /** Averages; null for an empty segment. */
  avgRecency: number | null;
  avgFrequency: number | null;
  avgMonetary: number | null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** One row per segment, every segment in RFM_SEGMENTS order (empty ones too). */
export function summarizeSegments(scored: ScoredCustomer[]): SegmentSummary[] {
  const total = scored.reduce((s, c) => s + c.monetary, 0);
  return RFM_SEGMENTS.map((segment) => {
    const list = scored.filter((c) => c.segment === segment);
    const revenue = list.reduce((s, c) => s + c.monetary, 0);
    const avg = (f: (c: ScoredCustomer) => number) => (list.length ? round(list.reduce((s, c) => s + f(c), 0) / list.length) : null);
    return {
      segment,
      customers: list.length,
      revenue: round(revenue),
      customerShare: scored.length ? list.length / scored.length : 0,
      revenueShare: total > 0 ? revenue / total : null,
      avgRecency: avg((c) => c.recency),
      avgFrequency: avg((c) => c.frequency),
      avgMonetary: avg((c) => c.monetary),
    };
  });
}

/** The cells of the R × FM grid that make up each segment, for the page's legend. */
export function segmentCells(segment: RfmSegment): { r: Score; fm: Score }[] {
  const out: { r: Score; fm: Score }[] = [];
  GRID.forEach((row, r) => row.forEach((s, fm) => s === segment && out.push({ r: (r + 1) as Score, fm: (fm + 1) as Score })));
  return out;
}

// ── SQL (the audience condition and the report share it) ────────────────────

/**
 * Customers of a `tx` CTE (./revenue-sql.ts) in one currency, whose
 * placeholder is `currency`: person, recency, frequency, monetary (numeric,
 * to the cent). The window is the tx CTE's; days count from now().
 */
export function rfmCustomersSql(tx: string, currency: string): string {
  return `select person,
             floor(extract(epoch from (now() - max(ts) filter (where kind <> 'refund'))) / 86400)::int as recency,
             (count(*) filter (where kind <> 'refund'))::int as frequency,
             round(coalesce(sum(case when kind = 'refund' then -amount else amount end), 0), 2) as monetary
        from ${tx} where currency = ${currency}::text
       group by person having count(*) filter (where kind <> 'refund') > 0`;
}

/** SQL for `quintile` over a column of `customers` (bigint arithmetic, so it equals the TypeScript exactly). */
function quintileSql(col: string, better: "asc" | "desc"): string {
  // rank() − 1 over worse-first order = customers with a strictly worse value.
  return `least(5, 1 + (5 * (rank() over (order by ${col} ${better}) - 1)) / greatest(count(*) over () - 1, 1))`;
}

/** `select person, r, f, m, segment` from a customers CTE (rfmCustomersSql). Segment keys are fixed literals. */
export function rfmSegmentsSql(customers: string): string {
  const cases = GRID.flatMap((row, r) => row.map((s, fm) => `when ${(r + 1) * 10 + fm + 1} then '${s}'`)).join(" ");
  return `select person, r, f, m, case r * 10 + (f + m + 1) / 2 ${cases} end as segment
        from (select person, ${quintileSql("recency", "desc")} as r, ${quintileSql("frequency", "asc")} as f, ${quintileSql("monetary", "asc")} as m
                from ${customers}) s`;
}

/** The audience condition for an RFM segment, as the page saves it. */
export function rfmAudience(segment: RfmSegment, window: RfmWindow, currency: string): AudienceNode {
  return { type: "rfm", segments: [segment], withinDays: window, currency };
}
