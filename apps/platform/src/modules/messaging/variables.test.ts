import { describe, expect, it } from "vitest";
import { fromParam, missingVariables, previewTemplate, resolveSample, smsSegments, toParam } from "./variables";

describe("template variable mapping", () => {
  it("round-trips sources and params", () => {
    expect(toParam({ kind: "user", value: "first_name" })).toBe("{{user.first_name}}");
    expect(toParam({ kind: "event", value: "" })).toBe("");
    expect(toParam({ kind: "text", value: " 20% " })).toBe("20%");
    expect(fromParam("{{ user.first_name }}")).toEqual({ kind: "user", value: "first_name" });
    expect(fromParam("{{event.total}}")).toEqual({ kind: "event", value: "total" });
    expect(fromParam("Hello {{user.x}}")).toEqual({ kind: "text", value: "Hello {{user.x}}" });
  });

  it("lists missing required variables by position", () => {
    expect(missingVariables(["1", "2", "3"], ["a", " ", undefined as unknown as string])).toEqual([2, 3]);
    expect(missingVariables(["name"], ["{{user.name}}"])).toEqual([]);
  });

  it("previews with sample values and leaves unknown references visible", () => {
    expect(resolveSample("Hi {{user.name}}, {{event.total}}", { user: { name: "Sara" } })).toBe("Hi Sara, {{event.total}}");
    expect(previewTemplate("Hi {{1}}, your code is {{2}}", ["1", "2"], ["{{user.name}}", ""], { user: { name: "Sara" } })).toBe("Hi Sara, your code is {{2}}");
    expect(previewTemplate("Hi {{first_name}}", ["first_name"], ["Omar"])).toBe("Hi Omar");
  });
});

describe("SMS segments", () => {
  it("counts GSM-7 and UCS-2 parts", () => {
    expect(smsSegments("")).toEqual({ encoding: "GSM-7", segments: 0, characters: 0 });
    expect(smsSegments("a".repeat(160))).toMatchObject({ encoding: "GSM-7", segments: 1 });
    expect(smsSegments("a".repeat(161))).toMatchObject({ segments: 2 });
    // Extension characters count twice.
    expect(smsSegments("€".repeat(80))).toMatchObject({ encoding: "GSM-7", characters: 160, segments: 1 });
    expect(smsSegments("مرحبا")).toMatchObject({ encoding: "UCS-2", segments: 1, characters: 5 });
    expect(smsSegments("م".repeat(71))).toMatchObject({ encoding: "UCS-2", segments: 2 });
  });
});
