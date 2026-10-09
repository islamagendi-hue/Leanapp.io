import { describe, expect, it } from "vitest";
import { channelEconomics, curveDays, ltvWindow, type EconomicsInput } from "./economics-pure";

const empty: EconomicsInput = { window: 7, acquired: [], spend: [], buyers: [], revenue: [], curvePeople: [], curveRevenue: [] };

describe("channelEconomics", () => {
  it("computes CAC from new users and LTV from first-time buyers, per currency, never across currencies", () => {
    const rows = channelEconomics({
      ...empty,
      acquired: [{ channel: "tiktok", people: 4 }, { channel: "organic", people: 10 }, { channel: "meta", people: 2 }],
      spend: [
        { source: "tiktok", currency: "SAR", amount: 100 },
        { source: "tiktok", currency: "SAR", amount: 100 },
        { source: "meta", currency: "SAR", amount: 40 },
        { source: "google", currency: "EUR", amount: 5 },
      ],
      buyers: [{ channel: "tiktok", buyers: 2, complete: 1 }, { channel: "organic", buyers: 1, complete: 1 }, { channel: "meta", buyers: 1, complete: 0 }],
      revenue: [
        { channel: "tiktok", currency: "SAR", net: 300 },
        { channel: "organic", currency: "SAR", net: 50 },
        { channel: "meta", currency: "USD", net: 30 },
      ],
    });
    expect(rows.map((r) => r.channel)).toEqual(["tiktok", "organic", "meta", "google"]);
    const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
    // CAC 200 ÷ 4 = 50; LTV 300 ÷ 2 = 150; LTV:CAC 3.
    expect(by.tiktok).toMatchObject({
      newUsers: 4, buyers: 2, buyersComplete: 1, currencyMismatch: false,
      amounts: [{ currency: "SAR", spend: 200, cac: 50, revenue: 300, ltv: 150, ltvToCac: 3 }],
    });
    expect(by.organic.amounts).toEqual([{ currency: "SAR", spend: null, cac: null, revenue: 50, ltv: 50, ltvToCac: null }]);
    expect(by.meta.currencyMismatch).toBe(true);
    expect(by.meta.amounts).toEqual([
      { currency: "SAR", spend: 40, cac: 20, revenue: null, ltv: null, ltvToCac: null },
      { currency: "USD", spend: null, cac: null, revenue: 30, ltv: 30, ltvToCac: null },
    ]);
    expect(by.google).toMatchObject({ newUsers: 0, buyers: 0, amounts: [{ currency: "EUR", spend: 5, cac: null, revenue: null, ltv: null, ltvToCac: null }] });
  });

  it("builds the cumulative curve only over buyers who have had that long", () => {
    const [row] = channelEconomics({
      ...empty,
      window: 30,
      buyers: [{ channel: "x", buyers: 3, complete: 1 }],
      revenue: [{ channel: "x", currency: "USD", net: 90 }],
      curvePeople: [{ channel: "x", day: 0, people: 3 }, { channel: "x", day: 7, people: 2 }, { channel: "x", day: 30, people: 1 }],
      curveRevenue: [{ channel: "x", currency: "USD", day: 0, net: 30 }, { channel: "x", currency: "USD", day: 7, net: 50 }, { channel: "x", currency: "USD", day: 30, net: 40 }],
    });
    expect(row.curve).toEqual([{ currency: "USD", points: [{ day: 0, people: 3, ltv: 10 }, { day: 7, people: 2, ltv: 25 }, { day: 30, people: 1, ltv: 40 }] }]);
    expect(row.amounts[0]).toMatchObject({ revenue: 90, ltv: 30 });
  });

  it("keeps the ratio unrounded until the end", () => {
    const [row] = channelEconomics({
      ...empty,
      acquired: [{ channel: "x", people: 3 }], spend: [{ source: "x", currency: "USD", amount: 10 }],
      buyers: [{ channel: "x", buyers: 3, complete: 3 }], revenue: [{ channel: "x", currency: "USD", net: 10 }],
    });
    expect(row.amounts[0]).toMatchObject({ cac: 3.33, ltv: 3.33, ltvToCac: 1 });
  });

  it("reads the window and its curve days", () => {
    expect(ltvWindow("30")).toBe(30);
    expect(ltvWindow("45")).toBe(90);
    expect(ltvWindow(undefined)).toBe(90);
    expect(curveDays(60)).toEqual([0, 7, 30, 60]);
  });
});
