import { describe, expect, it } from "vitest";
import { countFrame, parseCount } from "./count-up";

describe("count up", () => {
  it("keeps separators, decimals and the text around each number", () => {
    const c = parseCount("1,234.50 · 12.5%")!;
    expect(countFrame(c, 0)).toBe("0.00 · 0.0%");
    expect(countFrame(c, 0.5)).toBe("617.25 · 6.3%");
    expect(countFrame(c, 1)).toBe("1,234.50 · 12.5%");
  });

  it("counts signs and suffixes as text", () => {
    expect(countFrame(parseCount("−9.99")!, 1)).toBe("−9.99");
    expect(countFrame(parseCount("3.2×")!, 0.5)).toBe("1.6×");
    expect(countFrame(parseCount("1,000,000")!, 0.123)).toBe("123,000");
  });

  it("leaves long numbers without separators ungrouped", () => {
    expect(countFrame(parseCount("12345")!, 0.5)).toBe("6173");
  });

  it("has nothing to count without a non-zero number", () => {
    expect(parseCount("–")).toBeNull();
    expect(parseCount("0")).toBeNull();
    expect(parseCount("0.00")).toBeNull();
  });
});
