import { describe, expect, it } from "vitest";
import { growthDefinitionSchema } from "./definition";
import { applyBatchSql, rebuildSelectSql, windowSelectSql } from "./sql";

const def = growthDefinitionSchema.parse({
  activation: { event: "signup_completed", filters: [{ name: "method", op: "eq", value: "email" }] },
  core_action: { event: "order_completed", filters: [{ name: "revenue", op: "gt", value: "0" }] },
  revenue: { event: "order_completed", amount_property: "revenue", currency_property: "currency" },
});

/** Highest $n placeholder used in the SQL. */
const maxParam = (sql: string) => Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));

describe("growth SQL", () => {
  it("reserves the fixed binds and numbers definition values after them", () => {
    const r = rebuildSelectSql(def, "SAR", "Asia/Riyadh");
    expect(r.params.values.slice(0, 5)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(r.params.values.slice(5)).toEqual(["Asia/Riyadh", "order_completed", "revenue", "0", "order_completed", "revenue", "currency", "SAR", "signup_completed", "method", "email"]);
    expect(maxParam(r.sql)).toBe(r.params.values.length);
    const a = applyBatchSql(def, "SAR", "Asia/Riyadh");
    expect(a.params.values.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(maxParam(a.sql)).toBe(a.params.values.length);
    const w = windowSelectSql(def, "SAR", "Asia/Riyadh");
    expect(maxParam(w.sql)).toBe(w.params.values.length);
  });

  it("never puts definition values in the SQL text", () => {
    for (const { sql } of [rebuildSelectSql(def, "SAR", "Asia/Riyadh"), applyBatchSql(def, "SAR", "Asia/Riyadh"), windowSelectSql(def, "SAR", "Asia/Riyadh")]) {
      expect(sql).not.toMatch(/signup_completed|order_completed|email|SAR|Riyadh/);
    }
  });

  it("counts any event as a return unless retention is by core action", () => {
    expect(rebuildSelectSql(def, "USD", "UTC").sql).toMatch(/true as is_return/);
    const byCore = growthDefinitionSchema.parse({ ...def, retention: { return_event: "core_action" } });
    expect(rebuildSelectSql(byCore, "USD", "UTC").sql).not.toMatch(/true as is_return/);
  });

  it("retains a person on the calendar day N after their first day, in the app's timezone", () => {
    const { sql } = rebuildSelectSql(def, "SAR", "Asia/Riyadh");
    expect(sql).toMatch(/\(\(ts at time zone \$6\)::date - \(first_seen at time zone \$6\)::date\) = 7\) as retained_d7_at/);
    expect(sql).not.toMatch(/interval '7 days'/);
  });

  it("without definitions only activity and retention are derived", () => {
    const empty = growthDefinitionSchema.parse({});
    const r = rebuildSelectSql(empty, "USD", "UTC");
    expect(r.params.values.length).toBe(6); // the reserved binds and the timezone
    expect(r.sql).toMatch(/false as is_act/);
    expect(r.sql).toMatch(/null::numeric as amount/);
  });
});
