import { describe, expect, it } from "vitest";
import {
  fmScore, quintile, quintileScores, rfmAudience, rfmSegmentsSql, rfmWindow, RFM_SEGMENTS, scoreCustomers, segmentCells, segmentOf, summarizeSegments,
  type RfmCustomer, type Score,
} from "./rfm-pure";

const SCORES: Score[] = [1, 2, 3, 4, 5];

describe("quintile scores", () => {
  it("splits distinct values into fifths, 5 for the best", () => {
    expect(quintileScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    // Recency: fewer days is better.
    expect(quintileScores([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], false)).toEqual([5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    // Order of the input doesn't matter.
    expect(quintileScores([10, 1, 5])).toEqual([5, 1, 3]);
  });

  it("gives ties one score, the lower one", () => {
    // Everyone bought once: nobody is better than anybody, so nobody scores above 1.
    expect(quintileScores([1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 1]);
    // 6 of 10 bought once: one-time buyers are always 1, however many they are.
    expect(quintileScores([1, 1, 1, 1, 1, 1, 2, 2, 2, 7])).toEqual([1, 1, 1, 1, 1, 1, 4, 4, 4, 5]);
    // Tied values always share a score.
    const s = quintileScores([3, 9, 3, 9, 3, 1, 9]);
    expect(new Set([s[0], s[2], s[4]]).size).toBe(1);
    expect(new Set([s[1], s[3], s[6]]).size).toBe(1);
    // Recency ties: the same number of days.
    expect(quintileScores([2, 2, 30, 30, 90], false)).toEqual([4, 4, 2, 2, 1]);
  });

  it("works with fewer than 5 customers", () => {
    expect(quintileScores([42])).toEqual([1]);
    expect(quintileScores([1, 2])).toEqual([1, 5]);
    expect(quintileScores([1, 2, 3])).toEqual([1, 3, 5]);
    expect(quintileScores([])).toEqual([]);
  });

  it("stays within 1 to 5 for any split (the SQL uses the same integer formula)", () => {
    for (let n = 1; n <= 40; n++)
      for (let worse = 0; worse < n; worse++) {
        const q = quintile(worse, n);
        expect(q).toBeGreaterThanOrEqual(1);
        expect(q).toBeLessThanOrEqual(5);
        // Integer division, as Postgres computes it with bigints.
        expect(q).toBe(Math.min(5, 1 + Math.trunc((5 * worse) / Math.max(n - 1, 1))));
      }
    expect(quintile(0, 1)).toBe(1);
    expect(quintile(99, 100)).toBe(5);
  });

  it("handles zero and negative revenue like any other value", () => {
    expect(quintileScores([0, 0, 0, 0])).toEqual([1, 1, 1, 1]);
    expect(quintileScores([-10, 0, 50])).toEqual([1, 3, 5]);
  });
});

describe("segments", () => {
  it("maps every R × FM cell to exactly one segment, and every segment has cells", () => {
    const seen = new Set<string>();
    for (const r of SCORES) for (const fm of SCORES) seen.add(segmentOf(r, fm));
    expect([...seen].sort()).toEqual([...RFM_SEGMENTS].sort());
    const cells = RFM_SEGMENTS.flatMap((s) => segmentCells(s));
    expect(cells).toHaveLength(25);
  });

  it("places the classic corners", () => {
    expect(segmentOf(5, 5)).toBe("champions");
    expect(segmentOf(5, 1)).toBe("new_customers");
    expect(segmentOf(4, 1)).toBe("promising");
    expect(segmentOf(3, 3)).toBe("need_attention");
    expect(segmentOf(1, 5)).toBe("cant_lose");
    expect(segmentOf(2, 4)).toBe("at_risk");
    expect(segmentOf(2, 1)).toBe("hibernating");
    expect(segmentOf(1, 1)).toBe("lost");
    expect(segmentOf(3, 5)).toBe("loyal");
  });

  it("averages F and M, rounding half up", () => {
    expect(fmScore(1, 1)).toBe(1);
    expect(fmScore(1, 2)).toBe(2);
    expect(fmScore(4, 5)).toBe(5);
    expect(fmScore(2, 5)).toBe(4);
  });
});

describe("scoreCustomers and summarizeSegments", () => {
  const customers: RfmCustomer[] = [
    { person: "champ", recency: 1, frequency: 9, monetary: 900 },
    { person: "new", recency: 0, frequency: 1, monetary: 5 },
    { person: "gone", recency: 300, frequency: 1, monetary: 10 },
    { person: "whale", recency: 280, frequency: 8, monetary: 1500 },
    { person: "mid", recency: 60, frequency: 3, monetary: 120 },
  ];

  it("scores and segments each customer", () => {
    const s = Object.fromEntries(scoreCustomers(customers).map((c) => [c.person, c]));
    expect(s.champ).toMatchObject({ r: 4, f: 5, m: 4, segment: "loyal" });
    expect(s.new).toMatchObject({ r: 5, segment: "new_customers" });
    expect(s.gone).toMatchObject({ r: 1, segment: "lost" });
    expect(s.whale).toMatchObject({ r: 2, f: 4, m: 5, segment: "cant_lose" });
    expect(s.mid.segment).toBe("need_attention");
  });

  it("lists every segment, with shares that add up", () => {
    const sum = summarizeSegments(scoreCustomers(customers));
    expect(sum.map((x) => x.segment)).toEqual([...RFM_SEGMENTS]);
    expect(sum.reduce((a, x) => a + x.customers, 0)).toBe(5);
    expect(sum.reduce((a, x) => a + x.customerShare, 0)).toBeCloseTo(1);
    expect(sum.reduce((a, x) => a + (x.revenueShare ?? 0), 0)).toBeCloseTo(1);
    const empty = sum.find((x) => x.segment === "promising")!;
    expect(empty).toMatchObject({ customers: 0, revenue: 0, avgRecency: null, avgMonetary: null });
    expect(sum.find((x) => x.segment === "cant_lose")).toMatchObject({ customers: 1, revenue: 1500, avgFrequency: 8 });
  });

  it("has no revenue share when there is no revenue, and copes with no customers", () => {
    const sum = summarizeSegments(scoreCustomers([{ person: "a", recency: 3, frequency: 1, monetary: 0 }]));
    expect(sum.find((x) => x.customers)).toMatchObject({ segment: "lost", revenueShare: null });
    expect(summarizeSegments([]).every((x) => x.customers === 0 && x.customerShare === 0)).toBe(true);
  });
});

describe("RFM SQL and audience", () => {
  it("only splices fixed segment keys and numbers into the SQL", () => {
    const sql = rfmSegmentsSql("cust");
    for (const s of RFM_SEGMENTS) expect(sql).toContain(`'${s}'`);
    expect(sql).toContain("when 55 then 'champions'");
    expect(sql).toContain("when 11 then 'lost'");
  });

  it("builds the audience condition the page saves", () => {
    expect(rfmAudience("at_risk", 90, "SAR")).toEqual({ type: "rfm", segments: ["at_risk"], withinDays: 90, currency: "SAR" });
    expect(rfmWindow("180")).toBe(180);
    expect(rfmWindow("7")).toBe(365);
    expect(rfmWindow(undefined)).toBe(365);
  });
});
