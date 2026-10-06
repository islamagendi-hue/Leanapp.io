import { describe, expect, it } from "vitest";
import { asLimit, canAdd, countState, eventHardCap, eventState, retryAfterSeconds, thresholdsReached, usagePeriod } from "./limits";

describe("plan limits", () => {
  it("reads plan_features values as limits (null or invalid = unlimited)", () => {
    expect(asLimit(100)).toBe(100);
    expect(asLimit("25")).toBe(25);
    expect(asLimit(null)).toBeNull();
    expect(asLimit(undefined)).toBeNull();
    expect(asLimit(true)).toBeNull();
    expect(asLimit(-1)).toBeNull();
    expect(asLimit(2.7)).toBe(2);
  });

  it("gives monthly events a 10% grace before refusing", () => {
    expect(eventHardCap(100_000)).toBe(110_000);
    expect(eventHardCap(10)).toBe(11);
    expect(eventHardCap(5)).toBe(5); // floor(5.5): tiny limits get no rounding up
    expect(eventState(79, 100)).toBe("ok");
    expect(eventState(80, 100)).toBe("warning");
    expect(eventState(99, 100)).toBe("warning");
    expect(eventState(100, 100)).toBe("over");
    expect(eventState(109, 100)).toBe("over");
    expect(eventState(110, 100)).toBe("blocked");
    expect(eventState(10 ** 12, null)).toBe("ok");
  });

  it("blocks adding apps or seats at the limit, not before", () => {
    expect(canAdd(0, 1)).toBe(true);
    expect(canAdd(1, 1)).toBe(false);
    expect(canAdd(2, 3)).toBe(true);
    expect(canAdd(3, 3)).toBe(false);
    expect(canAdd(1000, null)).toBe(true);
    expect(countState(3, 3)).toBe("over");
    expect(countState(8, 10)).toBe("warning");
    expect(countState(7, 10)).toBe("ok");
  });

  it("lists the notice thresholds reached", () => {
    expect(thresholdsReached(79, 100)).toEqual([]);
    expect(thresholdsReached(80, 100)).toEqual([80]);
    expect(thresholdsReached(100, 100)).toEqual([80, 100]);
    expect(thresholdsReached(110, 100)).toEqual([80, 100, 110]);
    expect(thresholdsReached(1, null)).toEqual([]);
  });

  it("meters by calendar month in UTC and caps Retry-After", () => {
    const p = usagePeriod(new Date("2026-12-31T23:30:00Z"));
    expect(p.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(p.key).toBe("2026-12-01");
    expect(retryAfterSeconds(new Date("2026-12-31T23:30:00Z"))).toBe(1800);
    expect(retryAfterSeconds(new Date("2026-12-01T00:00:00Z"))).toBe(3600);
    expect(retryAfterSeconds(new Date("2026-12-31T23:59:59Z"))).toBe(60);
  });
});
