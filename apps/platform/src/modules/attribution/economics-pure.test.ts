import { describe, expect, it } from "vitest";
import { channelEconomics } from "./economics-pure";

describe("channelEconomics", () => {
  it("computes CAC, LTV and LTV:CAC per currency, never across currencies", () => {
    const rows = channelEconomics({
      acquired: [
        { channel: "tiktok", people: 4, paying: 2 },
        { channel: "organic", people: 10, paying: 1 },
        { channel: "meta", people: 2, paying: 1 },
      ],
      revenue: [
        { channel: "tiktok", currency: "SAR", net: 300 },
        { channel: "organic", currency: "SAR", net: 50 },
        { channel: "meta", currency: "USD", net: 30 },
      ],
      spend: [
        { source: "tiktok", currency: "SAR", amount: 100 },
        { source: "tiktok", currency: "SAR", amount: 100 },
        { source: "meta", currency: "SAR", amount: 40 },
        { source: "google", currency: "EUR", amount: 5 },
      ],
    });
    expect(rows.map((r) => r.channel)).toEqual(["organic", "tiktok", "meta", "google"]);
    const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
    expect(by.tiktok).toEqual({
      channel: "tiktok", newUsers: 4, payingUsers: 2, currencyMismatch: false,
      amounts: [{ currency: "SAR", spend: 200, cac: 50, revenue: 300, ltv: 75, ltvToCac: 1.5 }],
    });
    // No spend: no CAC and no ratio.
    expect(by.organic.amounts).toEqual([{ currency: "SAR", spend: null, cac: null, revenue: 50, ltv: 5, ltvToCac: null }]);
    // Spend in SAR, revenue in USD: each shown in its own currency, no ratio.
    expect(by.meta.currencyMismatch).toBe(true);
    expect(by.meta.amounts).toEqual([
      { currency: "SAR", spend: 40, cac: 20, revenue: null, ltv: null, ltvToCac: null },
      { currency: "USD", spend: null, cac: null, revenue: 30, ltv: 15, ltvToCac: null },
    ]);
    // Spend but no new users: no CAC.
    expect(by.google).toMatchObject({ newUsers: 0, currencyMismatch: false, amounts: [{ currency: "EUR", spend: 5, cac: null, revenue: 0, ltv: null, ltvToCac: null }] });
  });

  it("shows an LTV:CAC of 0 when a paid channel has no revenue yet", () => {
    const [row] = channelEconomics({ acquired: [{ channel: "snap", people: 3, paying: 0 }], revenue: [], spend: [{ source: "snap", currency: "SAR", amount: 90 }] });
    expect(row.amounts).toEqual([{ currency: "SAR", spend: 90, cac: 30, revenue: 0, ltv: 0, ltvToCac: 0 }]);
  });

  it("keeps the ratio unrounded until the end", () => {
    const [row] = channelEconomics({ acquired: [{ channel: "x", people: 3, paying: 1 }], revenue: [{ channel: "x", currency: "USD", net: 10 }], spend: [{ source: "x", currency: "USD", amount: 10 }] });
    expect(row.amounts[0]).toMatchObject({ cac: 3.33, ltv: 3.33, ltvToCac: 1 });
  });
});
