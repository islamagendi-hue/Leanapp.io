import { describe, expect, it } from "vitest";
import { assign, personKey, pickByWeight, unitHash } from "./bucketing";
import { sampleRatioMismatch } from "./stats";

const variants = [{ key: "control", weight: 50 }, { key: "treatment", weight: 50 }];
const exp = { salt: "salt-1", variants, trafficPercent: 100 };
const people = Array.from({ length: 20_000 }, (_, i) => `user-${i}`);

describe("bucketing", () => {
  it("is sticky: the same person always gets the same variant", () => {
    for (const p of people.slice(0, 200)) {
      const first = assign(exp, p).variant?.key;
      for (let i = 0; i < 3; i++) expect(assign(exp, p).variant?.key).toBe(first);
    }
  });

  it("differs between experiments (salt), so tests don't line up", () => {
    const other = { ...exp, salt: "salt-2" };
    const same = people.slice(0, 2000).filter((p) => assign(exp, p).variant?.key === assign(other, p).variant?.key).length;
    expect(same / 2000).toBeGreaterThan(0.45);
    expect(same / 2000).toBeLessThan(0.55);
  });

  it("splits by weight within tolerance", () => {
    const three = { salt: "s", trafficPercent: 100, variants: [{ key: "a", weight: 50 }, { key: "b", weight: 30 }, { key: "c", weight: 20 }] };
    const counts = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (const p of people) counts[assign(three, p).variant!.key]++;
    expect(counts.a / people.length).toBeGreaterThan(0.48);
    expect(counts.a / people.length).toBeLessThan(0.52);
    expect(counts.b / people.length).toBeGreaterThan(0.28);
    expect(counts.b / people.length).toBeLessThan(0.32);
    expect(counts.c / people.length).toBeGreaterThan(0.18);
    expect(counts.c / people.length).toBeLessThan(0.22);
    // The split our own sample ratio check would accept.
    expect(sampleRatioMismatch([counts.a, counts.b, counts.c], [50, 30, 20]).mismatch).toBe(false);
  });

  it("lets only the traffic share in, and changing traffic never moves people between variants", () => {
    const ten = { ...exp, trafficPercent: 10 };
    const inside = people.filter((p) => assign(ten, p).variant);
    expect(inside.length / people.length).toBeGreaterThan(0.09);
    expect(inside.length / people.length).toBeLessThan(0.11);
    const outside = people.find((p) => !assign(ten, p).variant)!;
    expect(assign(ten, outside).reason).toBe("outside_traffic");
    for (const p of inside.slice(0, 500)) expect(assign(ten, p).variant!.key).toBe(assign(exp, p).variant!.key);
    // Raising traffic keeps everyone who was in.
    const fifty = { ...exp, trafficPercent: 50 };
    for (const p of inside) expect(assign(fifty, p).variant).not.toBeNull();
  });

  it("respects audience targeting", () => {
    expect(assign(exp, "user-1", false)).toEqual({ variant: null, reason: "not_in_audience" });
    expect(assign(exp, "user-1", true).reason).toBe("assigned");
  });

  it("maps a unit value to the variant by cumulative weight", () => {
    expect(pickByWeight(variants, 0).key).toBe("control");
    expect(pickByWeight(variants, 0.4999).key).toBe("control");
    expect(pickByWeight(variants, 0.5).key).toBe("treatment");
    expect(pickByWeight(variants, 0.9999999).key).toBe("treatment");
    const u = unitHash("s", "variant", "p");
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it("resolves the person like Analytics does", () => {
    expect(personKey({ userId: "u1", anonymousId: "a1" })).toBe("u1");
    expect(personKey({ anonymousId: "a1", linkedUserId: "u9" })).toBe("u9");
    expect(personKey({ anonymousId: "a1" })).toBe("anon:a1");
    expect(personKey({})).toBeNull();
  });
});
