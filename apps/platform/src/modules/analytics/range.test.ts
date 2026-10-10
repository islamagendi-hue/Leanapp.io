import { describe, expect, it } from "vitest";
import { inputFromParams, paramsFromConfig, rangeFromParams } from "./report-params";
import { addDays, bucketKeys, bucketSql, change, defaultInterval, comparisonRange, previousRange, rangeDays, resolveRange, shortDay, startOfDay } from "./range";
import { measurable } from "./retention-rule";

const now = new Date("2026-10-08T12:00:00Z");

describe("report ranges", () => {
  it("keeps presets exactly as before: the last N days, ending now", () => {
    const r = resolveRange({ days: "30" }, "Asia/Riyadh", now);
    expect(r).toMatchObject({ preset: 30, from: "2026-09-08", to: "2026-10-08", label: "Last 30 days" });
    expect(r.end).toEqual(now);
    expect(now.getTime() - r.start.getTime()).toBe(30 * 86_400_000);
    expect(resolveRange({ days: "12" }, "UTC", now).preset).toBe(30); // unknown preset falls back
  });

  it("turns custom calendar days into instants in the app's timezone", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2026-09-30" }, "Asia/Riyadh", now);
    expect(r).toMatchObject({ preset: null, from: "2026-09-01", to: "2026-09-30" });
    expect(r.start.toISOString()).toBe("2026-08-31T21:00:00.000Z"); // midnight in Riyadh (UTC+3)
    expect(r.end.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(r.label).toMatch(/^1 \w+ 2026 – 30 \w+ 2026$/);
  });

  it("orders swapped dates, stops at now and caps the span", () => {
    const r = resolveRange({ from: "2026-10-08", to: "2026-10-01" }, "UTC", now);
    expect([r.from, r.to]).toEqual(["2026-10-01", "2026-10-08"]);
    expect(r.end).toEqual(now); // today isn't over
    expect(resolveRange({ from: "2026-10-01", to: "2027-01-01" }, "UTC", now).to).toBe("2026-10-08");
    expect(resolveRange({ from: "2020-01-01", to: "2026-10-08" }, "UTC", now).from).toBe(addDays("2026-10-08", -365));
    expect(resolveRange({ from: "nope", to: "2026-10-01", days: 7 }, "UTC", now).preset).toBe(7);
  });

  it("handles daylight saving when finding midnight", () => {
    expect(startOfDay("2026-03-29", "Europe/London").toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfDay("2026-03-30", "Europe/London").toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("compares with the period of the same length just before", () => {
    const r = resolveRange({ from: "2026-09-01", to: "2026-09-30" }, "UTC", now);
    const p = previousRange(r, "UTC");
    expect([p.from, p.to]).toEqual(["2026-08-02", "2026-08-31"]);
    expect(p.end).toEqual(r.start);
    const last7 = previousRange(resolveRange({ days: 7 }, "UTC", now), "UTC");
    expect(now.getTime() - last7.start.getTime()).toBe(14 * 86_400_000);
    expect(change(120, 100)).toBeCloseTo(0.2);
    expect(change(5, 0)).toBeNull();
    expect(change(5, null)).toBeNull();
  });

  it("buckets by day, ISO week or month, matching the SQL", () => {
    const range = { from: "2026-09-29", to: "2026-10-08" };
    expect(bucketKeys(range, "day")).toHaveLength(10);
    expect(bucketKeys(range, "week")).toEqual(["2026-09-28", "2026-10-05"]); // Mondays
    expect(bucketKeys(range, "month")).toEqual(["2026-09-01", "2026-10-01"]);
    expect(bucketSql("ts", "$3", "week")).toBe("date_trunc('week', ts at time zone $3)::date");
    expect(defaultInterval(range)).toBe("day");
    expect(defaultInterval({ from: "2026-01-01", to: "2026-10-08" })).toBe("week");
    expect(defaultInterval(range, "month")).toBe("month");
  });
});

describe("comparison periods", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const range = resolveRange({ from: "2026-10-01", to: "2026-10-07" }, "UTC", now);

  it("offers 15 days as a preset", () => {
    expect(rangeDays(15)).toBe(15);
    expect(resolveRange({ days: 15 }, "UTC", now)).toMatchObject({ preset: 15, from: "2026-09-24", to: "2026-10-09" });
  });

  it("is the period before, the same days a year earlier, or custom days", () => {
    expect(comparisonRange(range, "UTC", {})).toBeNull();
    expect(comparisonRange(range, "UTC", { compare: true })).toMatchObject({ from: "2026-09-24", to: "2026-09-30" });
    expect(comparisonRange(range, "UTC", { compare: "year" })).toMatchObject({ from: "2025-10-01", to: "2025-10-07", label: "1 Oct 2025 – 7 Oct 2025" });
    expect(comparisonRange(range, "UTC", { compare: "custom", cfrom: "2026-08-01", cto: "2026-08-31" })).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(comparisonRange(range, "UTC", { compare: "custom", cfrom: "2026-08-01" })).toBeNull();
  });

  it("moves 29 February to 28 February a year earlier", () => {
    const leap = resolveRange({ from: "2028-02-29", to: "2028-02-29" }, "UTC", new Date("2028-03-10T00:00:00Z"));
    expect(comparisonRange(leap, "UTC", { compare: "year" })).toMatchObject({ from: "2027-02-28", to: "2027-02-28" });
  });
});

describe("range settings in URLs and saved reports", () => {
  it("uses dates only for a custom range, and round-trips them", () => {
    expect(rangeFromParams(new URLSearchParams("days=7&from=2026-09-01&to=2026-09-30"))).toEqual({ days: "7", from: undefined, to: undefined, compare: undefined, cfrom: undefined, cto: undefined });
    const custom = new URLSearchParams("event=x&days=custom&from=2026-09-01&to=2026-09-30&compare=1&interval=week");
    const input = inputFromParams("trend", custom);
    expect(input).toMatchObject({ from: "2026-09-01", to: "2026-09-30", compare: true, interval: "week" });
    const back = paramsFromConfig("trend", { event: "x", days: 30, from: "2026-09-01", to: "2026-09-30", compare: true, interval: "week" });
    expect(Object.fromEntries(back)).toEqual({ event: "x", interval: "week", days: "custom", from: "2026-09-01", to: "2026-09-30", compare: "1" });
  });

  it("compares with the previous period, a year earlier or custom days, and round-trips the choice", () => {
    const q = new URLSearchParams("event=x&days=15&compare=custom&cfrom=2026-08-01&cto=2026-08-15");
    expect(inputFromParams("trend", q)).toMatchObject({ days: "15", compare: "custom", cfrom: "2026-08-01", cto: "2026-08-15" });
    expect(Object.fromEntries(paramsFromConfig("trend", { event: "x", days: 15, compare: "custom", cfrom: "2026-08-01", cto: "2026-08-15" })))
      .toEqual({ event: "x", days: "15", compare: "custom", cfrom: "2026-08-01", cto: "2026-08-15" });
    expect(rangeFromParams(new URLSearchParams("compare=year&cfrom=2026-08-01&cto=2026-08-15"))).toMatchObject({ compare: "year", cfrom: undefined, cto: undefined });
    expect(rangeFromParams(new URLSearchParams("compare="))).toMatchObject({ compare: undefined });
  });

  it("opens configs saved before ranges existed exactly as before", () => {
    expect(Object.fromEntries(paramsFromConfig("funnel", { steps: ["a", "b"], windowDays: 7, days: 90 }))).toEqual({ step: "b", window: "7", days: "90" });
    expect(paramsFromConfig("funnel", { steps: ["a", "b"], windowDays: 7, days: 90 }).getAll("step")).toEqual(["a", "b"]);
  });
});

describe("retention rule", () => {
  it("measures day N only once it is over", () => {
    expect(measurable("2026-10-01", 7, "2026-10-08")).toBe(false); // day 7 is today
    expect(measurable("2026-10-01", 6, "2026-10-08")).toBe(true);
  });
});

describe("short days", () => {
  it("reads as day and month in the reader's language, with Latin digits in Arabic", () => {
    expect(shortDay("2026-10-02", "en")).toBe("2 Oct");
    expect(shortDay("2026-10-02", "ar")).toBe("2 أكتوبر");
    expect(shortDay("week 3")).toBe("week 3");
  });
});
