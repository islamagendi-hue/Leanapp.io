import { describe, expect, it } from "vitest";
import { growthDefinitionSchema } from "./definition";
import { applyEventSql, rebuildSelectSql, windowSelectSql } from "./sql";

const def = growthDefinitionSchema.parse({
  activation: { event: "signup_completed", filters: [{ name: "method", op: "eq", value: "email" }] },
  core_action: { event: "order_completed", filters: [{ name: "revenue", op: "gt", value: "0" }] },
  revenue: { event: "order_completed", amount_property: "revenue", currency_property: "currency" },
});

/** Highest $n placeholder used in the SQL. */
const maxParam = (sql: string) => Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

describe("growth SQL", () => {
  it("reserves the fixed binds and numbers definition values after them", () => {
    const r = rebuildSelectSql(def, "SAR");
    expect(r.params.values.slice(0, 5)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(r.params.values.slice(5)).toEqual(["order_completed", "revenue", "0", "order_completed", "revenue", "currency", "SAR", "signup_completed", "method", "email"]);
    expect(maxParam(r.sql)).toBe(r.params.values.length);
    const a = applyEventSql(def, "SAR");
    expect(a.params.values.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(maxParam(a.sql)).toBe(a.params.values.length);
    const w = windowSelectSql(def, "SAR");
    expect(maxParam(w.sql)).toBe(w.params.values.length);
  });

  it("never puts definition values in the SQL text", () => {
    for (const { sql } of [rebuildSelectSql(def, "SAR"), applyEventSql(def, "SAR"), windowSelectSql(def, "SAR")]) {
      expect(sql).not.toMatch(/signup_completed|order_completed|email|SAR/);
    }
  });

  it("counts any event as a return unless retention is by core action", () => {
    expect(rebuildSelectSql(def, "USD").sql).toMatch(/true as is_return/);
    const byCore = growthDefinitionSchema.parse({ ...def, retention: { return_event: "core_action" } });
    expect(rebuildSelectSql(byCore, "USD").sql).not.toMatch(/true as is_return/);
  });

  it("without definitions only activity and retention are derived", () => {
    const empty = growthDefinitionSchema.parse({});
    const r = rebuildSelectSql(empty, "USD");
    expect(r.params.values.length).toBe(5);
    expect(r.sql).toMatch(/false as is_act/);
    expect(r.sql).toMatch(/null::numeric as amount/);
  });
});
