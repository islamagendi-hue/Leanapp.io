import { describe, expect, it } from "vitest";
import { compileAudience, describeNode, parseDefinition, type AudienceNode } from "./definition";

const ENV = "00000000-0000-0000-0000-000000000001";

describe("parseDefinition", () => {
  it("fills defaults and accepts nested groups", () => {
    const def = parseDefinition({
      type: "and",
      children: [
        { type: "event", event: "purchase" },
        { type: "not", child: { type: "user_property", property: "plan", op: "eq", value: "gold" } },
        { type: "or", children: [{ type: "platform", platforms: ["ios"] }, { type: "first_seen", op: "within_days", days: 7 }] },
      ],
    });
    expect(def.type).toBe("and");
    const ev = (def as { children: AudienceNode[] }).children[0];
    expect(ev).toMatchObject({ type: "event", did: true, countOp: "gte", count: 1, withinDays: 30, where: [] });
  });

  it("rejects unknown operators, leaf kinds and unsafe property names", () => {
    expect(() => parseDefinition({ type: "user_property", property: "plan", op: "; drop table", value: "x" })).toThrow();
    expect(() => parseDefinition({ type: "sql", raw: "1=1" })).toThrow();
    expect(() => parseDefinition({ type: "user_property", property: "a'; drop table platform.events; --", op: "eq", value: "x" })).toThrow(/Property names/);
    expect(() => parseDefinition({ type: "user_property", property: "age", op: "gt", value: "ten" })).toThrow(/needs a number/);
    expect(() => parseDefinition({ type: "and", children: [] })).toThrow(/at least one/);
  });

  it("limits depth and size", () => {
    let deep: AudienceNode = { type: "platform", platforms: ["ios"] };
    for (let i = 0; i < 7; i++) deep = { type: "not", child: deep };
    expect(() => parseDefinition(deep)).toThrow(/nested/);
    const wide = { type: "or", children: Array.from({ length: 21 }, () => ({ type: "platform", platforms: ["ios"] })) };
    expect(() => parseDefinition(wide)).toThrow();
  });

  it("only allows since-the-trigger windows in automations", () => {
    const leaf = { type: "event", event: "purchase", sinceTrigger: true };
    expect(() => parseDefinition(leaf)).toThrow(/automation/);
    expect(parseDefinition(leaf, { allowSinceTrigger: true })).toMatchObject({ sinceTrigger: true });
  });
});

describe("compileAudience", () => {
  it("binds every user value as a parameter", () => {
    const evil = "x'); delete from platform.events; --";
    const def = parseDefinition({
      type: "or",
      children: [
        { type: "event", event: evil, where: [{ property: "plan", op: "eq", value: evil }, { property: "tier", op: "in", value: [evil, "b"] }] },
        { type: "user_property", property: "city", op: "contains", value: "%_" + evil },
        { type: "revenue", op: "gte", amount: 100, events: [evil] },
      ],
    });
    const { sql, params } = compileAudience(def, ENV);
    expect(sql).not.toContain("delete from");
    expect(sql).not.toContain(evil);
    expect(sql).not.toContain("%_");
    expect(params).toContain(evil);
    expect(params).toContainEqual([evil, "b"]);
    expect(params[0]).toBe(ENV);
    // Every placeholder has a value and vice versa.
    const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(Math.max(...used)).toBe(params.length);
    expect(used.size).toBe(params.length);
  });

  it("compiles did / did not / counts and boolean structure", () => {
    const { sql } = compileAudience(
      parseDefinition({
        type: "and",
        children: [
          { type: "event", event: "a", count: 3 },
          { type: "event", event: "b", did: false },
          { type: "not", child: { type: "event", event: "c", countOp: "lte", count: 2 } },
        ],
      }),
      ENV,
    );
    expect(sql).toMatch(/coalesce\(c1\.n, 0\) >= \$\d+::int/);
    expect(sql).toMatch(/coalesce\(c2\.n, 0\) = 0/);
    expect(sql).toMatch(/not \(coalesce\(c3\.n, 0\) >= 1 and coalesce\(c3\.n, 0\) <= \$\d+::int\)/);
    expect(sql).toContain(" and ");
    // Pending deletions are always excluded.
    expect(sql).toContain("r.kind = 'deletion'");
  });

  it("evaluates for a single person with a trigger window", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const def = parseDefinition({ type: "event", event: "purchase", sinceTrigger: true }, { allowSinceTrigger: true });
    const { sql, params } = compileAudience(def, ENV, { personKey: "u1", triggerAt: at });
    expect(params).toContain("u1");
    expect(params).toContain(at.toISOString());
    expect(sql).toContain("::timestamptz");
    expect(() => compileAudience(def, ENV)).toThrow(/trigger time/);
  });

  it("uses only whitelisted SQL for operators", () => {
    for (const op of ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "exists", "not_exists"]) {
      const value = ["gt", "gte", "lt", "lte"].includes(op) ? 5 : op === "in" ? ["a"] : op.includes("exists") ? undefined : "a";
      const { sql } = compileAudience(parseDefinition({ type: "user_property", property: "k", op, value }), ENV);
      expect(sql).not.toMatch(/\bk\b'/);
    }
  });
});

describe("describeNode", () => {
  it("reads like a sentence", () => {
    const def = parseDefinition({
      type: "and",
      children: [
        { type: "event", event: "purchase", count: 2, withinDays: 14, where: [{ property: "plan", op: "eq", value: "gold" }] },
        { type: "event", event: "checkout_started", did: false, withinDays: 1 },
      ],
    });
    expect(describeNode(def)).toBe('(did purchase where plan is "gold" at least 2 times in the last 14 days AND did not do checkout_started in the last 1 days)');
  });
});
