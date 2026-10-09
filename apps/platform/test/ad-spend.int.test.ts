/**
 * Ad spend entered by hand or by CSV (modules/attribution/spend): validation,
 * replace-on-resave, CSV row errors (nothing saved), delete, permissions,
 * audit entries and isolation between organizations.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { localDate } from "@/modules/analytics/range";
import { deleteSpend, importSpendCsv, listSpend, saveSpend } from "@/modules/attribution/spend";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
const tz = "Asia/Riyadh";
const scopeOf = (t: T) => ({ appId: t.app.id, environmentId: t.dev.id, timezone: tz });
const today = () => localDate(new Date(), tz);

beforeAll(async () => {
  A = await makeTenant("spend");
  B = await makeTenant("spend-b");
});

describe("ad spend", () => {
  it("saves a day's spend and replaces it when the same day is saved again", async () => {
    await saveSpend(A.ctx, scopeOf(A), { date: "2026-10-01", source: "tiktok", campaign: "", currency: "sar", amount: "100" });
    await saveSpend(A.ctx, scopeOf(A), { date: "2026-10-01", source: "tiktok", campaign: "", currency: "SAR", amount: "150.5" });
    await saveSpend(A.ctx, scopeOf(A), { date: "2026-10-01", source: "tiktok", campaign: "eid", currency: "SAR", amount: "20" });
    await saveSpend(A.ctx, scopeOf(A), { date: "2026-10-01", source: "tiktok", campaign: "", currency: "USD", amount: "7" });
    const rows = await listSpend(A.ctx, A.dev.id);
    expect(rows.map((r) => [r.date, r.source, r.campaign, r.currency, r.amount])).toEqual([
      ["2026-10-01", "tiktok", null, "SAR", 150.5],
      ["2026-10-01", "tiktok", null, "USD", 7],
      ["2026-10-01", "tiktok", "eid", "SAR", 20],
    ]);
    const logs = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1 and action like 'attribution.spend%'", [A.org.id]));
    expect(logs).toHaveLength(4);
  });

  it("rejects wrong entries with the field that is wrong", async () => {
    const bad = async (raw: Record<string, unknown>) => {
      const err = await saveSpend(A.ctx, scopeOf(A), { date: "2026-10-01", source: "meta", currency: "USD", amount: "1", ...raw }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return Object.keys((err as ValidationError).details as object);
    };
    expect(await bad({ date: "yesterday" })).toEqual(["date"]);
    const tomorrow = new Date(`${today()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(await bad({ date: tomorrow.toISOString().slice(0, 10) })).toEqual(["date"]);
    expect(await bad({ source: "organic" })).toEqual(["source"]);
    expect(await bad({ currency: "dollars" })).toEqual(["currency"]);
    expect(await bad({ amount: "-1" })).toEqual(["amount"]);
    await expect(saveSpend(A.ctx, scopeOf(A), { date: today(), source: "meta", currency: "USD", amount: "0" })).resolves.toBeTruthy();
  });

  it("imports CSV, and saves nothing when a row is wrong", async () => {
    const bad = await importSpendCsv(A.ctx, scopeOf(A), "date,source,campaign,currency,amount\n2026-09-01,snap,,SAR,10\n2026-09-02,snap,,SAR,ten\n2026-09-03,snap,SAR,10");
    expect(bad).toEqual({ imported: 0, errors: [expect.objectContaining({ line: 3 }), expect.objectContaining({ line: 4 })] });
    expect((await listSpend(A.ctx, A.dev.id)).some((r) => r.source === "snap")).toBe(false);

    const ok = await importSpendCsv(A.ctx, scopeOf(A), "2026-09-01,snap,,SAR,10\n2026-09-02,snap,,SAR,12.25\n2026-10-01,tiktok,,SAR,99");
    expect(ok).toEqual({ imported: 3, errors: [] });
    const rows = await listSpend(A.ctx, A.dev.id);
    expect(rows.filter((r) => r.source === "snap").map((r) => r.amount).sort()).toEqual([10, 12.25]);
    expect(rows.find((r) => r.source === "tiktok" && r.date === "2026-10-01" && r.currency === "SAR" && !r.campaign)?.amount).toBe(99); // replaced
  });

  it("deletes an entry", async () => {
    const row = (await listSpend(A.ctx, A.dev.id)).find((r) => r.source === "snap")!;
    await deleteSpend(A.ctx, A.app.id, row.id);
    expect((await listSpend(A.ctx, A.dev.id)).some((r) => r.id === row.id)).toBe(false);
    await expect(deleteSpend(A.ctx, A.app.id, row.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("needs attribution.manage to change spend and analytics.read to see it", async () => {
    const analyst: TenantContext = { ...A.ctx, role: "analyst" };
    const viewer: TenantContext = { ...A.ctx, role: "viewer" };
    const marketer: TenantContext = { ...A.ctx, role: "marketer" };
    const entry = { date: "2026-09-05", source: "google", currency: "SAR", amount: "5" };
    await expect(saveSpend(analyst, scopeOf(A), entry)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importSpendCsv(viewer, scopeOf(A), "2026-09-05,google,,SAR,5")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listSpend(viewer, A.dev.id)).length).toBeGreaterThan(0);
    await expect(saveSpend(marketer, scopeOf(A), entry)).resolves.toBeTruthy();
  });

  it("keeps each organization to its own spend", async () => {
    const aRow = (await listSpend(A.ctx, A.dev.id))[0];
    expect(await listSpend(B.ctx, A.dev.id)).toEqual([]);
    await expect(deleteSpend(B.ctx, B.app.id, aRow.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteSpend(B.ctx, A.app.id, aRow.id)).rejects.toBeInstanceOf(NotFoundError);
    // B can't write into A's environment, even naming its own app.
    await expect(saveSpend(B.ctx, { ...scopeOf(A), appId: B.app.id }, { date: "2026-09-05", source: "x", currency: "SAR", amount: "1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveSpend(B.ctx, scopeOf(A), { date: "2026-09-05", source: "x", currency: "SAR", amount: "1" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listSpend(A.ctx, A.dev.id)).some((r) => r.source === "x")).toBe(false);
  });
});
