import { describe, expect, it } from "vitest";
import { buildExperiment, ExperimentError, formOf, NEW_FORM, type ExperimentForm } from "./definition";

const base: ExperimentForm = { ...NEW_FORM, name: "Price on button", key: "checkout_button", goalEvent: "order_completed" };

describe("experiment form", () => {
  it("builds a definition from the form, and back", () => {
    const d = buildExperiment({ ...base, hypothesis: " More checkouts ", goalFilterName: "payment_method", goalFilterOp: "eq", goalFilterValue: "mada", secondaryKind: "revenue" });
    expect(d).toEqual({
      key: "checkout_button", name: "Price on button", hypothesis: "More checkouts",
      variants: [{ key: "control", name: "Control", weight: 50 }, { key: "treatment", name: "Treatment", weight: 50 }],
      trafficPercent: 100, audienceId: null,
      goal: { event: "order_completed", filter: { name: "payment_method", op: "eq", value: "mada" }, window_days: 7 },
      secondary: { kind: "revenue" },
    });
    expect(buildExperiment(formOf(d))).toEqual(d);
  });

  it("takes up to five variants and skips empty optional rows", () => {
    const d = buildExperiment({ ...base, variantKey2: "b", variantWeight2: "20", variantKey3: "", variantName3: "", variantKey4: "c", variantWeight4: "10" });
    expect(d.variants.map((v) => [v.key, v.weight])).toEqual([["control", 50], ["treatment", 50], ["b", 20], ["c", 10]]);
    expect(d.variants[2].name).toBe("b");
  });

  it("rejects what can't run", () => {
    const bad = (f: ExperimentForm) => () => buildExperiment({ ...base, ...f });
    expect(bad({ name: "x" })).toThrow(ExperimentError);
    expect(bad({ key: "Checkout Button" })).toThrow(/key starts with a letter/);
    expect(bad({ variantKey1: "control" })).toThrow(/must be different/);
    expect(bad({ variantWeight1: "0" })).toThrow(/weight/);
    expect(bad({ variantKey1: "", variantName1: "", variantWeight1: "" })).toThrow(/key/);
    expect(bad({ traffic: "0" })).toThrow(/Traffic/);
    expect(bad({ traffic: "101" })).toThrow(/Traffic/);
    expect(bad({ goalEvent: "" })).toThrow(/goal event/);
    expect(bad({ goalEvent: "experiment_exposure" })).toThrow(/exposure event/);
    expect(bad({ goalWindow: "120" })).toThrow(/1 to 90/);
    expect(bad({ goalFilterName: "amount", goalFilterOp: "gt", goalFilterValue: "abc" })).toThrow(/number/);
    expect(bad({ secondaryKind: "event", secondaryEvent: "" })).toThrow(/secondary event/);
    expect(bad({ audienceId: "not-a-uuid" })).toThrow(/audience/);
  });
});
