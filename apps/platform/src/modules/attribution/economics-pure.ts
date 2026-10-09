/**
 * CAC and LTV by acquisition channel (see ./economics.ts for the queries).
 * Pure, so the arithmetic and the currency rules are unit-tested without a
 * database.
 *
 * Per channel:
 * - new users: people whose first install on record falls in the range;
 * - CAC = spend ÷ new users, per spend currency (none without spend or new users);
 * - revenue: net revenue (gross − refunds) of those new users in the range, per currency;
 * - LTV = that revenue ÷ new users: observed revenue to date, not a forecast;
 * - LTV:CAC = LTV ÷ CAC (= revenue ÷ spend), only when the spend and every bit of the channel's
 *   revenue are in one currency. Nothing is converted between currencies.
 */

export interface ChannelAmount {
  currency: string;
  /** Spend entered for the channel in this currency over the range; null when none. */
  spend: number | null;
  /** spend ÷ new users; null without spend or without new users. */
  cac: number | null;
  /**
   * Net revenue of the channel's new users in this currency. 0 when the
   * channel has no revenue at all; null when its revenue is only in other currencies.
   */
  revenue: number | null;
  /** revenue ÷ new users; null when revenue is null or there are no new users. */
  ltv: number | null;
  /** ltv ÷ cac; null unless spend and all of the channel's revenue share this currency. */
  ltvToCac: number | null;
}

export interface ChannelEconomics {
  channel: string;
  newUsers: number;
  /** New users with at least one revenue transaction (not a refund) in the range. */
  payingUsers: number;
  /** One entry per currency of the channel's spend or revenue (spend currencies first). */
  amounts: ChannelAmount[];
  /** The channel has spend and revenue, but not all in one currency, so some LTV:CAC can't be shown. */
  currencyMismatch: boolean;
}

export interface EconomicsInput {
  acquired: { channel: string; people: number; paying: number }[];
  /** Net revenue (gross − refunds) of the new users, per channel and currency. */
  revenue: { channel: string; currency: string; net: number }[];
  spend: { source: string; currency: string; amount: number }[];
}

const round = (n: number) => Math.round(n * 100) / 100;

export function channelEconomics(input: EconomicsInput): ChannelEconomics[] {
  const channels = new Map<string, { newUsers: number; payingUsers: number; spend: Map<string, number>; revenue: Map<string, number> }>();
  const ensure = (c: string) => {
    if (!channels.has(c)) channels.set(c, { newUsers: 0, payingUsers: 0, spend: new Map(), revenue: new Map() });
    return channels.get(c)!;
  };
  for (const a of input.acquired) {
    const c = ensure(a.channel);
    c.newUsers += a.people;
    c.payingUsers += a.paying;
  }
  for (const r of input.revenue) {
    const m = ensure(r.channel).revenue;
    m.set(r.currency, (m.get(r.currency) ?? 0) + r.net);
  }
  // Spend sources are matched to channels exactly, as in Revenue by channel.
  for (const s of input.spend) {
    const m = ensure(s.source).spend;
    m.set(s.currency, (m.get(s.currency) ?? 0) + s.amount);
  }

  return [...channels.entries()]
    .map(([channel, c]): ChannelEconomics => {
      const revenueCurrencies = [...c.revenue.keys()].sort();
      const currencies = [...[...c.spend.keys()].sort(), ...revenueCurrencies.filter((x) => !c.spend.has(x))];
      const amounts = currencies.map((currency): ChannelAmount => {
        const spend = c.spend.has(currency) ? round(c.spend.get(currency)!) : null;
        const cac = spend !== null && c.newUsers > 0 ? round(spend / c.newUsers) : null;
        const revenue = c.revenue.has(currency) ? round(c.revenue.get(currency)!) : revenueCurrencies.length === 0 ? 0 : null;
        const ltv = revenue !== null && c.newUsers > 0 ? round(revenue / c.newUsers) : null;
        // Compare only like with like: every bit of the channel's revenue is in this currency (or there is none).
        const comparable = revenueCurrencies.every((x) => x === currency);
        // LTV ÷ CAC = (revenue ÷ new users) ÷ (spend ÷ new users) = revenue ÷ spend, computed unrounded.
        const ltvToCac = comparable && cac && revenue !== null ? round((c.revenue.get(currency) ?? 0) / c.spend.get(currency)!) : null;
        return { currency, spend, cac, revenue, ltv, ltvToCac };
      });
      const currencyMismatch = c.spend.size > 0 && revenueCurrencies.length > 0 && amounts.some((a) => a.spend !== null && !revenueCurrencies.every((x) => x === a.currency));
      return { channel, newUsers: c.newUsers, payingUsers: c.payingUsers, amounts, currencyMismatch };
    })
    .sort((a, b) => b.newUsers - a.newUsers || Number(b.amounts.some((x) => x.spend !== null)) - Number(a.amounts.some((x) => x.spend !== null)) || a.channel.localeCompare(b.channel));
}
