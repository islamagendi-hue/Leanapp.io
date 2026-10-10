import { describe, expect, it } from "vitest";
import { alphaFor, chiSquareSurvival, compareProportions, enoughData, normalCdf, sampleRatioMismatch, twoSidedP } from "./stats";

// Reference values computed independently (Python math.erfc and closed forms of the chi-square tail).
describe("normal distribution", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(twoSidedP(1.959963984540054)).toBeCloseTo(0.05, 6);
    expect(twoSidedP(-2.5758293035489)).toBeCloseTo(0.01, 6);
  });
});

describe("two-proportion z-test", () => {
  // 100 of 1,000 converted in the control, 130 of 1,000 in the variant.
  const r = compareProportions({ n: 1000, x: 100 }, { n: 1000, x: 130 });

  it("gives the textbook z and p-value (pooled standard error)", () => {
    expect(r.z).toBeCloseTo(2.1027406, 5);
    expect(r.pValue).toBeCloseTo(0.0354885, 5);
  });

  it("gives a 95% interval for the difference (unpooled) and for the relative uplift (log ratio)", () => {
    expect(r.diff).toBeCloseTo(0.03, 10);
    expect(r.diffLow).toBeCloseTo(0.0020679, 6);
    expect(r.diffHigh).toBeCloseTo(0.0579321, 6);
    expect(r.uplift).toBeCloseTo(0.3, 10);
    expect(r.upliftLow).toBeCloseTo(0.0169843, 6);
    expect(r.upliftHigh).toBeCloseTo(0.6617759, 6);
  });

  it("is symmetric and says nothing when the rates are equal", () => {
    const back = compareProportions({ n: 1000, x: 130 }, { n: 1000, x: 100 });
    expect(back.z).toBeCloseTo(-r.z, 10);
    expect(back.pValue).toBeCloseTo(r.pValue, 10);
    const same = compareProportions({ n: 500, x: 50 }, { n: 500, x: 50 });
    expect(same.z).toBe(0);
    expect(same.pValue).toBe(1);
  });

  it("handles empty groups and a control with no conversions without NaN", () => {
    const empty = compareProportions({ n: 0, x: 0 }, { n: 0, x: 0 });
    expect(empty.pValue).toBe(1);
    expect(empty.uplift).toBeNull();
    const noControl = compareProportions({ n: 200, x: 0 }, { n: 200, x: 10 });
    expect(noControl.uplift).toBeNull();
    expect(Number.isFinite(noControl.z)).toBe(true);
  });

  it("waits for enough people and conversions in both groups", () => {
    expect(enoughData({ n: 1000, x: 100 }, { n: 1000, x: 130 })).toBe(true);
    expect(enoughData({ n: 99, x: 10 }, { n: 1000, x: 130 })).toBe(false);
    expect(enoughData({ n: 1000, x: 4 }, { n: 1000, x: 130 })).toBe(false);
    expect(enoughData({ n: 100, x: 98 }, { n: 1000, x: 130 })).toBe(false); // fewer than 5 non-conversions
  });

  it("splits 5% across several treatments", () => {
    expect(alphaFor(1)).toBe(0.05);
    expect(alphaFor(3)).toBeCloseTo(0.0166667, 6);
  });
});

describe("chi-square and sample ratio mismatch", () => {
  it("matches closed forms of the chi-square tail", () => {
    expect(chiSquareSurvival(4.081632653061225, 1)).toBeCloseTo(0.0433518, 6);
    expect(chiSquareSurvival(12, 2)).toBeCloseTo(0.0024788, 6);
    expect(chiSquareSurvival(7.8147, 3)).toBeCloseTo(0.0500006, 5);
    expect(chiSquareSurvival(0, 4)).toBe(1);
  });

  it("flags a split far from the weights, and not a plausible one", () => {
    const fine = sampleRatioMismatch([5000, 4800], [50, 50]);
    expect(fine.chiSquare).toBeCloseTo(4.0816327, 6);
    expect(fine.pValue).toBeCloseTo(0.0433518, 6);
    expect(fine.mismatch).toBe(false); // p > 0.001

    const bad = sampleRatioMismatch([5000, 4500], [50, 50]);
    expect(bad.pValue).toBeLessThan(0.001);
    expect(bad.mismatch).toBe(true);

    // Uneven weights: 90/10 observed as 900/100 is exactly as configured.
    const uneven = sampleRatioMismatch([900, 100], [90, 10]);
    expect(uneven.chiSquare).toBeCloseTo(0, 10);
    expect(uneven.expected).toEqual([900, 100]);
    expect(uneven.mismatch).toBe(false);
  });

  it("doesn't call a mismatch on a handful of people", () => {
    expect(sampleRatioMismatch([20, 2], [50, 50]).mismatch).toBe(false);
    expect(sampleRatioMismatch([0, 0, 0], [1, 1, 1]).pValue).toBe(1);
  });
});
