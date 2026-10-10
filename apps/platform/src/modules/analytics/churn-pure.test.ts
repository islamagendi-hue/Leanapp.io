import { describe, expect, it } from "vitest";
import { compileAudience, parseDefinition } from "@/modules/audiences/definition";
import {
  atRiskDays, bucketSql, churnAudience, churnByChannel, churnInterval, churnPeriods, churnSeries, churnWindow, classify, CHURN_WINDOWS,
} from "./churn-pure";

const DAY = 86_400_000;
const now = new Date("2026-10-09T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe("churn classification", () => {
  it("puts everyone in one bucket by the days since last seen", () => {
    expect(classify(ago(0), now, 30)).toBe("active");
    expect(classify(ago(15), now, 30)).toBe("active"); // exactly N/2 days: not yet at risk
    expect(classify(ago(15.01), now, 30)).toBe("at_risk");
    expect(classify(ago(30), now, 30)).toBe("at_risk"); // exactly N days: not yet churned
    expect(classify(ago(30.01), now, 30)).toBe("churned");
    expect(classify(ago(400), now, 30)).toBe("churned");
    expect(classify(ago(10), now, 14)).toBe("at_risk");
  });

  it("offers windows whose half is a whole number of days, with 30 by default", () => {
    for (const w of CHURN_WINDOWS) expect(Number.isInteger(atRiskDays(w))).toBe(true);
    expect(churnWindow("60")).toBe(60);
    expect(churnWindow(["90"])).toBe(90);
    expect(churnWindow("31")).toBe(30);
    expect(churnWindow(undefined)).toBe(30);
    expect(churnInterval("month")).toBe("month");
    expect(churnInterval("day")).toBe("week");
  });

  it("uses the same comparisons as the audience's last-seen conditions", () => {
    const sql = bucketSql("p.last_seen_at", "$2", "$3");
    expect(sql).toMatch(/p\.last_seen_at < now\(\) - make_interval\(days => \$2::int\) then 'churned'/);
    expect(sql).toMatch(/p\.last_seen_at < now\(\) - make_interval\(days => \$3::int\) then 'at_risk'/);
    const churned = compileAudience(parseDefinition(churnAudience("churned", 30)), "env").sql;
    expect(churned).toContain("p.last_seen_at < now() - make_interval(days =>");
  });

  it("saves each bucket as a valid audience condition", () => {
    expect(parseDefinition(churnAudience("churned", 60))).toEqual({ type: "last_seen", op: "before_days", days: 60 });
    expect(parseDefinition(churnAudience("at_risk", 60))).toEqual({
      type: "and", children: [{ type: "last_seen", op: "before_days", days: 30 }, { type: "last_seen", op: "within_days", days: 60 }],
    });
    expect(parseDefinition(churnAudience("active", 14))).toEqual({ type: "last_seen", op: "within_days", days: 7 });
  });
});

describe("churn periods", () => {
  it("lists the last weeks, Monday first, the current one up to today", () => {
    const weeks = churnPeriods("2026-10-09", "week", 3); // a Friday
    expect(weeks).toEqual([
      { start: "2026-09-21", end: "2026-09-28", partial: false },
      { start: "2026-09-28", end: "2026-10-05", partial: false },
      { start: "2026-10-05", end: "2026-10-10", partial: true },
    ]);
    expect(churnPeriods("2026-10-04", "week", 1)).toEqual([{ start: "2026-09-28", end: "2026-10-05", partial: false }]); // Sunday: the week is complete at its end
  });

  it("lists the last months across a year boundary", () => {
    expect(churnPeriods("2026-02-10", "month", 3)).toEqual([
      { start: "2025-12-01", end: "2026-01-01", partial: false },
      { start: "2026-01-01", end: "2026-02-01", partial: false },
      { start: "2026-02-01", end: "2026-02-11", partial: true },
    ]);
    expect(churnPeriods("2026-10-09", "month")).toHaveLength(6);
    expect(churnPeriods("2026-10-09", "week")).toHaveLength(12);
  });

  it("computes the rate per period, empty without anyone active at the start", () => {
    const periods = churnPeriods("2026-10-09", "week", 2);
    const s = churnSeries(periods, [{ start: "2026-10-05", base: 40, churned: 10 }]);
    expect(s[0]).toMatchObject({ base: 0, churned: 0, rate: null });
    expect(s[1]).toMatchObject({ base: 40, churned: 10, rate: 0.25, partial: true });
  });
});

describe("churn by channel", () => {
  it("adds up the buckets per channel, biggest first", () => {
    const rows = churnByChannel([
      { channel: "organic", bucket: "churned", people: 2 },
      { channel: "tiktok", bucket: "churned", people: 5 },
      { channel: "tiktok", bucket: "active", people: 10 },
      { channel: "tiktok", bucket: "at_risk", people: 5 },
      { channel: "organic", bucket: "active", people: 2 },
    ]);
    expect(rows).toEqual([
      { channel: "tiktok", people: 20, churned: 5, atRisk: 5, active: 10, rate: 0.25 },
      { channel: "organic", people: 4, churned: 2, atRisk: 0, active: 2, rate: 0.5 },
    ]);
    expect(churnByChannel([])).toEqual([]);
  });
});
