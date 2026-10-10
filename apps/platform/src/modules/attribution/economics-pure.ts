/**
 * CAC and LTV by acquisition channel (see ./economics.ts for the queries).
 * Pure, so the arithmetic and the currency rules are unit-tested without a
 * database.
 *
 * Two cohorts, both by the selected range:
 * - CAC cohort: new users, people whose first install on record falls in the
 *   range. CAC = spend ÷ new users, per spend currency.
 * - LTV cohort: first-time buyers, people whose first purchase ever (first
 *   revenue transaction that isn't a refund) falls in the range. Each gets a
 *   window of N days from their own first purchase. LTV = net revenue
 *   (gross − refunds) of the cohort inside their windows ÷ buyers, per
 *   currency. It is observed revenue, not a forecast: when some windows
 *   haven't ended yet, it only covers the days that have passed (see
 *   `buyersComplete`).
 * - LTV:CAC = LTV ÷ CAC, only when the spend and every bit of the channel's
 *   cohort revenue are in one currency. Nothing is converted.
 * The channel of a person is their first install's source in both cohorts.
 */

/** Window lengths (days after each person's first purchase) offered for LTV. */
export const LTV_WINDOWS = [7, 30, 60, 90, 180, 365] as const;
export type LtvWindow = (typeof LTV_WINDOWS)[number];
export const DEFAULT_LTV_WINDOW: LtvWindow = 90;

export function ltvWindow(v: unknown): LtvWindow {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return (LTV_WINDOWS as readonly number[]).includes(n) ? (n as LtvWindow) : DEFAULT_LTV_WINDOW;
}

/** Points of the cumulative LTV curve: day 0 (the first 24 hours) and every offered window up to N. */
export function curveDays(window: LtvWindow): number[] {
  return [0, ...LTV_WINDOWS.filter((d) => d <= window)];
}

export interface ChannelAmount {
  currency: string;
  /** Spend entered for the channel in this currency over the range; null when none. */
  spend: number | null;
  /** spend ÷ new users; null without spend or without new users. */
  cac: number | null;
  /** Net revenue of the channel's first-time buyers inside their windows, in this currency; null when none. */
  revenue: number | null;
  /** revenue ÷ buyers; null without revenue in this currency. */
  ltv: number | null;
  /** ltv ÷ cac; null unless spend and all of the channel's cohort revenue share this currency. */
  ltvToCac: number | null;
}

export interface CurvePoint {
  /** Days after the first purchase (0 = the first 24 hours). */
  day: number;
  /** Buyers who have had at least this many days (max(day, 1)) since their first purchase. */
  people: number;
  /** Their net revenue in the first max(day, 1) days ÷ people; null when nobody has had that long. */
  ltv: number | null;
}

export interface ChannelEconomics {
  channel: string;
  /** People whose first install is in the range (the CAC cohort). */
  newUsers: number;
  /** People whose first purchase is in the range (the LTV cohort). */
  buyers: number;
  /** Buyers whose whole window has passed. */
  buyersComplete: number;
  /** One entry per currency of the channel's spend or cohort revenue (spend currencies first). */
  amounts: ChannelAmount[];
  /** Cumulative LTV per currency of the cohort's revenue, at each curve day. */
  curve: { currency: string; points: CurvePoint[] }[];
  /** The channel has spend and cohort revenue, but not all in one currency, so some LTV:CAC can't be shown. */
  currencyMismatch: boolean;
}

export interface EconomicsInput {
  window: LtvWindow;
  /** New users (first install in the range) per channel. */
  acquired: { channel: string; people: number }[];
  spend: { source: string; currency: string; amount: number }[];
  /** First-time buyers per channel, and how many of them have had the whole window. */
  buyers: { channel: string; buyers: number; complete: number }[];
  /** Net revenue of the buyers inside their windows, per channel and currency. */
  revenue: { channel: string; currency: string; net: number }[];
  /** Buyers who have had at least max(day, 1) days, per channel and curve day. */
  curvePeople: { channel: string; day: number; people: number }[];
  /** Those buyers' net revenue in their first max(day, 1) days, per channel, currency and curve day. */
  curveRevenue: { channel: string; currency: string; day: number; net: number }[];
}

const round = (n: number) => Math.round(n * 100) / 100;

interface Acc {
  newUsers: number;
  buyers: number;
  complete: number;
  spend: Map<string, number>;
  revenue: Map<string, number>;
  people: Map<number, number>;
  curve: Map<string, number>;
}

export function channelEconomics(input: EconomicsInput): ChannelEconomics[] {
  const channels = new Map<string, Acc>();
  const ensure = (c: string) => {
    if (!channels.has(c)) channels.set(c, { newUsers: 0, buyers: 0, complete: 0, spend: new Map(), revenue: new Map(), people: new Map(), curve: new Map() });
    return channels.get(c)!;
  };
  const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const a of input.acquired) ensure(a.channel).newUsers += a.people;
  // Spend sources are matched to channels exactly, as in Revenue by channel.
  for (const s of input.spend) add(ensure(s.source).spend, s.currency, s.amount);
  for (const b of input.buyers) {
    const c = ensure(b.channel);
    c.buyers += b.buyers;
    c.complete += b.complete;
  }
  for (const r of input.revenue) add(ensure(r.channel).revenue, r.currency, r.net);
  for (const p of input.curvePeople) add(ensure(p.channel).people, p.day, p.people);
  for (const r of input.curveRevenue) add(ensure(r.channel).curve, `${r.currency}\u0000${r.day}`, r.net);
  const days = curveDays(input.window);

  return [...channels.entries()]
    .map(([channel, c]): ChannelEconomics => {
      const revenueCurrencies = [...c.revenue.keys()].sort();
      const currencies = [...[...c.spend.keys()].sort(), ...revenueCurrencies.filter((x) => !c.spend.has(x))];
      const amounts = currencies.map((currency): ChannelAmount => {
        const rawSpend = c.spend.get(currency);
        const rawRevenue = c.revenue.get(currency);
        const cacRaw = rawSpend !== undefined && c.newUsers > 0 ? rawSpend / c.newUsers : null;
        const ltvRaw = rawRevenue !== undefined && c.buyers > 0 ? rawRevenue / c.buyers : null;
        // Compare only like with like: every bit of the channel's cohort revenue is in this currency.
        const comparable = revenueCurrencies.every((x) => x === currency);
        return {
          currency,
          spend: rawSpend === undefined ? null : round(rawSpend),
          cac: cacRaw === null ? null : round(cacRaw),
          revenue: rawRevenue === undefined ? null : round(rawRevenue),
          ltv: ltvRaw === null ? null : round(ltvRaw),
          ltvToCac: comparable && cacRaw && ltvRaw !== null ? round(ltvRaw / cacRaw) : null,
        };
      });
      const curve = revenueCurrencies.map((currency) => ({
        currency,
        points: days.map((day): CurvePoint => {
          const people = c.people.get(day) ?? 0;
          return { day, people, ltv: people ? round((c.curve.get(`${currency}\u0000${day}`) ?? 0) / people) : null };
        }),
      }));
      const currencyMismatch = c.spend.size > 0 && revenueCurrencies.length > 0 && currencies.some((x) => c.spend.has(x) && !revenueCurrencies.every((r) => r === x));
      return { channel, newUsers: c.newUsers, buyers: c.buyers, buyersComplete: c.complete, amounts, curve, currencyMismatch };
    })
    .sort((a, b) => b.buyers - a.buyers || b.newUsers - a.newUsers || Number(b.amounts.some((x) => x.spend !== null)) - Number(a.amounts.some((x) => x.spend !== null)) || a.channel.localeCompare(b.channel));
}
