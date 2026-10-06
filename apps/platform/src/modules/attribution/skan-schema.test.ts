import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateConversion, EXAMPLE_SCHEMA, parseConversionSchema, windowFor, type ConversionState } from "./skan-schema";

/** Shared vectors, meant to be run by the iOS SDK too once it applies schemas. */
const vectors = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../test/fixtures/conversion-schema-vectors.json"), "utf8")) as {
  schema: unknown;
  cases: { name: string; steps: { event: string; revenue?: number; currency?: string; hours: number; expect: unknown }[] }[];
};

describe("conversion value schema", () => {
  it("evaluates the shared vectors", () => {
    const parsed = parseConversionSchema(vectors.schema);
    if (!parsed.ok) throw new Error(parsed.message);
    for (const c of vectors.cases) {
      let state: ConversionState = {};
      for (const [i, step] of c.steps.entries()) {
        const out = evaluateConversion(parsed.schema, state, { name: step.event, revenue: step.revenue ?? null, currency: step.currency ?? null }, 0, step.hours * 3_600_000);
        expect(out.update, `${c.name} step ${i}`).toEqual(step.expect);
        state = out.state;
      }
    }
  });

  it("maps time since install to Apple's windows", () => {
    const h = 3_600_000;
    expect([0, 47.9, 48, 167, 168, 839, 840].map((x) => windowFor(0, x * h))).toEqual([0, 0, 1, 1, 2, 2, null]);
  });

  it("validates schemas", () => {
    expect(parseConversionSchema(EXAMPLE_SCHEMA).ok).toBe(true);
    expect(parseConversionSchema(JSON.stringify(EXAMPLE_SCHEMA)).ok).toBe(true);
    const bad = (rules: unknown[], extra: object = { currency: "SAR" }) => parseConversionSchema({ ...extra, rules });
    expect(bad([{ window: 0, event: "x", fine: 64 }])).toMatchObject({ ok: false, message: expect.stringContaining("0–63") });
    expect(bad([{ window: 1, event: "x", fine: 3 }])).toMatchObject({ ok: false, message: expect.stringContaining("first window") });
    expect(bad([{ window: 3, event: "x", coarse: "low" }]).ok).toBe(false);
    expect(bad([{ window: 0, fine: 3 }])).toMatchObject({ ok: false, message: expect.stringContaining("event or a revenue range") });
    expect(bad([{ window: 0, event: "x" }])).toMatchObject({ ok: false, message: expect.stringContaining("fine or a coarse") });
    expect(bad([{ window: 0, min_revenue: 10, max_revenue: 5, coarse: "low" }]).ok).toBe(false);
    expect(bad([{ window: 0, min_revenue: 10, coarse: "low" }], {})).toMatchObject({ ok: false, message: expect.stringContaining("currency") });
    expect(bad([{ window: 0, event: "x", coarse: "low", extra: 1 }]).ok).toBe(false);
    expect(bad([])).toMatchObject({ ok: false });
    expect(parseConversionSchema("{")).toEqual({ ok: false, message: "The schema is not valid JSON." });
  });
});
