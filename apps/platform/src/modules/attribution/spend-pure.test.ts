import { describe, expect, it } from "vitest";
import { grossReturn, parseSpendCsv, roas, validateSpend } from "./spend-pure";

const today = "2026-10-09";

describe("validateSpend", () => {
  it("cleans a valid entry", () => {
    expect(validateSpend({ date: "2026-10-08", source: " tiktok ", campaign: "", currency: "sar", amount: "1,250.5" }, today)).toEqual({
      ok: true,
      value: { date: "2026-10-08", source: "tiktok", campaign: "", currency: "SAR", amount: 1250.5 },
    });
  });

  it("names the first wrong field", () => {
    const field = (raw: Record<string, unknown>) => {
      const r = validateSpend({ date: "2026-10-08", source: "meta", campaign: "", currency: "USD", amount: "10", ...raw }, today);
      return r.ok ? null : r.field;
    };
    expect(field({ date: "2026-02-30" })).toBe("date");
    expect(field({ date: "2026-10-10" })).toBe("date"); // tomorrow in the app's timezone
    expect(field({ source: "" })).toBe("source");
    expect(field({ source: "Organic" })).toBe("source");
    expect(field({ source: "(no install on record)" })).toBe("source");
    expect(field({ campaign: "x".repeat(101) })).toBe("campaign");
    expect(field({ currency: "US" })).toBe("currency");
    expect(field({ amount: "-5" })).toBe("amount");
    expect(field({ amount: "1.234" })).toBe("amount");
    expect(field({ amount: "abc" })).toBe("amount");
    expect(field({ amount: "0" })).toBeNull();
  });
});

describe("parseSpendCsv", () => {
  it("skips the header and blank lines, handles quotes, and keeps the last row of a duplicate", () => {
    const csv = 'date,source,campaign,currency,amount\r\n2026-10-01,tiktok,ramadan,SAR,100\n\n2026-10-01,meta,"eid, ksa",USD,"1,000.25"\n2026-10-01,tiktok,ramadan,SAR,120\n';
    const r = parseSpendCsv(csv, today);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { date: "2026-10-01", source: "tiktok", campaign: "ramadan", currency: "SAR", amount: 120 },
      { date: "2026-10-01", source: "meta", campaign: "eid, ksa", currency: "USD", amount: 1000.25 },
    ]);
  });

  it("reports each wrong line by its number", () => {
    const r = parseSpendCsv("2026-10-01,tiktok,,SAR,100\n2026-13-01,tiktok,,SAR,100\n2026-10-01,tiktok,SAR,100\n2026-10-01,organic,,SAR,5", today);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(r.rows).toHaveLength(1);
  });

  it("asks for at least one row", () => {
    expect(parseSpendCsv("date,source,campaign,currency,amount\n", today).errors).toHaveLength(1);
  });
});

describe("return and ROAS", () => {
  it("are blank without spend", () => {
    expect(grossReturn(100, null)).toBeNull();
    expect(roas(100, null)).toBeNull();
    expect(roas(100, 0)).toBeNull();
    expect(grossReturn(100, 0)).toBe(100);
  });
  it("divide and subtract in one currency", () => {
    expect(roas(320, 100)).toBe(3.2);
    expect(grossReturn(320, 100)).toBe(220);
    expect(grossReturn(50, 80)).toBe(-30);
  });
});
