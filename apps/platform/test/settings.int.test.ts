/** Organization settings, plan usage and the audit log viewer. */
import { beforeAll, describe, expect, it } from "vitest";
import { listAuditLogs } from "@/modules/audit/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { getOrganization, updateOrganization } from "@/modules/organizations/service";
import { usageSummary } from "@/modules/usage/service";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;

beforeAll(async () => {
  t = await makeTenant("settings");
  other = await makeTenant("settings-other");
});

const profile = { name: "Renamed Co", country: "AE", timezone: "Asia/Dubai", defaultCurrency: "AED", industry: "delivery" };

describe("organization settings", () => {
  it("updates the profile and audits what changed", async () => {
    await updateOrganization(t.ctx, profile);
    const o = await getOrganization(t.ctx);
    expect(o).toMatchObject({ name: "Renamed Co", country: "AE", timezone: "Asia/Dubai", default_currency: "AED", industry: "delivery", slug: t.org.slug });
    const { rows } = await listAuditLogs(t.ctx, { area: "organization" });
    expect(rows[0].action).toBe("organization.updated");
    expect(rows[0].metadata.changed).toMatchObject({ name: { to: "Renamed Co" }, default_currency: { from: "SAR", to: "AED" } });

    await updateOrganization(t.ctx, profile); // no changes: no new entry
    expect((await listAuditLogs(t.ctx, { area: "organization" })).rows.filter((r) => r.action === "organization.updated")).toHaveLength(1);
  });

  it("validates and checks permissions", async () => {
    await expect(updateOrganization(t.ctx, { ...profile, timezone: "Mars/Olympus" })).rejects.toThrow(/timezone/);
    await expect(updateOrganization(t.ctx, { ...profile, defaultCurrency: "dollars" })).rejects.toThrow(/currency/);
    await expect(updateOrganization({ ...t.ctx, role: "developer" }, profile)).rejects.toThrow(/permission/);
  });
});

describe("plan & usage", () => {
  it("counts this month's events, apps and members against the plan", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    const batch = [1, 2, 3].map(() => ({ type: "track", event_name: "item_viewed", event_id: crypto.randomUUID(), anonymous_id: "a1" }));
    await ingest(sdk, { batch }, { mode: "batch" });
    const u = await usageSummary(t.ctx);
    expect(u.plan).toEqual({ id: "free", name: expect.any(String), retentionDays: 30 });
    const line = (k: string) => u.lines.find((l) => l.key === k)!;
    expect(line("events")).toMatchObject({ used: 3, limit: 100000 });
    expect(line("apps")).toMatchObject({ used: 1, limit: 1 });
    expect(line("seats")).toMatchObject({ used: 1, limit: 3 });
    expect((await usageSummary(other.ctx)).lines.find((l) => l.key === "events")!.used).toBe(0);
    await expect(usageSummary({ ...t.ctx, role: "developer" })).rejects.toThrow(/permission/);
  });
});

describe("audit log", () => {
  it("pages newest first and stays inside the organization", async () => {
    const all = (await listAuditLogs(t.ctx, { limit: 200 })).rows;
    expect(all.length).toBeGreaterThan(3);
    const first = await listAuditLogs(t.ctx, { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
    const second = await listAuditLogs(t.ctx, { limit: 2, before: first.next! });
    expect(second.rows.map((r) => r.id)).toEqual(all.slice(2, 4).map((r) => r.id));
    expect(all[all.length - 1].action).toBe("organization.created");
    expect(all.find((r) => r.action === "organization.created")!.actor_name).toBe(t.user.name);

    const theirs = (await listAuditLogs(other.ctx, { limit: 200 })).rows.map((r) => r.id);
    expect(theirs.some((id) => all.some((r) => r.id === id))).toBe(false);
    await expect(listAuditLogs({ ...t.ctx, role: "analyst" })).rejects.toThrow(/permission/);
    expect((await listAuditLogs(t.ctx, { before: "'; drop table x; --", area: "../x" })).rows.length).toBe(Math.min(all.length, 50));
  });
});
