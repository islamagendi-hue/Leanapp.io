import { describe, expect, it } from "vitest";
import { applyAvailability, DELIVERY_CHANNELS, FUNNEL_METRICS, rateOf, UNAVAILABLE } from "./metrics";

describe("delivery metrics", () => {
  const raw = { sent: 10, failed: 2, delivered: 8, opened: 5, clicked: 1 };

  it("hides what a channel can't report instead of showing zero", () => {
    expect(applyAvailability("push", raw)).toEqual({ sent: 10, failed: 2, delivered: null, opened: null, clicked: null });
    expect(applyAvailability("whatsapp", raw)).toEqual({ sent: 10, failed: 2, delivered: 8, opened: 5, clicked: null });
    expect(applyAvailability("in_app", raw)).toEqual({ sent: 10, failed: 2, delivered: null, opened: 5, clicked: 1 });
  });

  it("gives a reason for every metric that isn't available", () => {
    for (const c of DELIVERY_CHANNELS) for (const m of FUNNEL_METRICS) {
      const why = UNAVAILABLE[c][m];
      expect(why === null || why.length > 10).toBe(true);
    }
  });

  it("computes rates only when they mean something", () => {
    expect(rateOf(5, 10)).toBe(0.5);
    expect(rateOf(null, 10)).toBeNull();
    expect(rateOf(0, 0)).toBeNull();
  });
});
