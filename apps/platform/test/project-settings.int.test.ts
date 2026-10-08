/** Project settings: rename, timezone and currency, environments, archive and restore, and the Viewer role. */
import { beforeAll, describe, expect, it } from "vitest";
import { archiveApp, createApp, getAppBySlug, listApps, listArchivedApps, restoreApp, setEnvironmentStatus, updateApp, updateAppLocale } from "@/modules/apps/service";
import { listAuditLogs } from "@/modules/audit/service";
import { authenticateIngestionKey, listKeys } from "@/modules/credentials/service";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;

beforeAll(async () => {
  t = await makeTenant("project");
  other = await makeTenant("project-other");
});

describe("project settings", () => {
  it("renames a project without changing its slug, and audits what changed", async () => {
    await updateApp(t.ctx, t.app.id, { name: "Renamed App", description: "Groceries", category: "delivery" });
    const { app } = await getAppBySlug(t.ctx, t.app.slug);
    expect(app).toMatchObject({ name: "Renamed App", description: "Groceries", category: "delivery", slug: t.app.slug });
    const { rows } = await listAuditLogs(t.ctx, { area: "app" });
    expect(rows[0]).toMatchObject({ action: "app.updated", metadata: { changed: { name: { to: "Renamed App" } } } });

    await updateApp(t.ctx, t.app.id, { name: "Renamed App", description: "Groceries", category: "delivery" }); // no change, no entry
    expect((await listAuditLogs(t.ctx, { area: "app" })).rows.filter((r) => r.action === "app.updated")).toHaveLength(1);
    await expect(updateApp(t.ctx, t.app.id, { name: "x" })).rejects.toThrow(/name/);
  });

  it("changes the reporting timezone and currency", async () => {
    await updateAppLocale(t.ctx, t.app.id, { timezone: "Asia/Dubai", defaultCurrency: "aed" });
    expect((await getAppBySlug(t.ctx, t.app.slug)).app).toMatchObject({ timezone: "Asia/Dubai", default_currency: "AED" });
    await expect(updateAppLocale(t.ctx, t.app.id, { timezone: "Mars/Olympus", defaultCurrency: "AED" })).rejects.toThrow(/timezone/);
    await expect(updateAppLocale(t.ctx, t.app.id, { timezone: "UTC", defaultCurrency: "dollars" })).rejects.toThrow(/currency/);
  });

  it("checks permissions and never reaches another workspace's project", async () => {
    await expect(updateApp({ ...t.ctx, role: "viewer" }, t.app.id, { name: "Nope" })).rejects.toThrow(/permission/);
    await expect(updateApp({ ...t.ctx, role: "analyst" }, t.app.id, { name: "Nope" })).rejects.toThrow(/permission/);
    await updateApp({ ...t.ctx, role: "developer" }, t.app.id, { name: "Dev Renamed" });
    await expect(archiveApp({ ...t.ctx, role: "developer" }, t.app.id)).rejects.toThrow(/permission/);
    await expect(updateApp(other.ctx, t.app.id, { name: "Hijack" })).rejects.toThrow(/not found/i);
    await expect(archiveApp(other.ctx, t.app.id)).rejects.toThrow(/not found/i);
    await expect(setEnvironmentStatus(other.ctx, t.dev.id, "disabled")).rejects.toThrow(/not found/i);
    expect((await getAppBySlug(t.ctx, t.app.slug)).app.name).toBe("Dev Renamed");
  });

  it("pauses and resumes a test environment, which stops and restarts its ingestion", async () => {
    expect(await authenticateIngestionKey(t.sdkKey)).not.toBeNull();
    await setEnvironmentStatus(t.ctx, t.dev.id, "disabled");
    expect(await authenticateIngestionKey(t.sdkKey)).toBeNull();
    await setEnvironmentStatus(t.ctx, t.dev.id, "active");
    expect(await authenticateIngestionKey(t.sdkKey)).not.toBeNull();
    const prod = t.environments.find((e) => e.type === "production")!;
    await expect(setEnvironmentStatus(t.ctx, prod.id, "disabled")).rejects.toThrow(/Production/);
    const actions = (await listAuditLogs(t.ctx, { area: "environment" })).rows.map((r) => r.action);
    expect(actions.slice(0, 2)).toEqual(["environment.enabled", "environment.disabled"]);
  });
});

describe("project lifecycle", () => {
  it("archives a project: ingestion stops, it leaves the list and the plan count, and its data stays", async () => {
    const keys = await listKeys(other.ctx, other.app.id);
    const prodKey = keys.sdkKeys.find((k) => k.environment_id === other.environments.find((e) => e.type === "production")!.id)!.key;
    expect(await authenticateIngestionKey(prodKey)).not.toBeNull();

    await archiveApp(other.ctx, other.app.id);
    expect(await authenticateIngestionKey(prodKey)).toBeNull();
    expect(await authenticateIngestionKey(other.sdkKey)).toBeNull();
    expect((await listApps(other.ctx)).map((a) => a.id)).not.toContain(other.app.id);
    expect((await listArchivedApps(other.ctx)).map((a) => a.id)).toEqual([other.app.id]);
    expect((await getAppBySlug(other.ctx, other.app.slug)).app.status).toBe("archived");
    await expect(archiveApp(other.ctx, other.app.id)).rejects.toThrow(/already archived/);

    // The free plan allows one active app; the archived one no longer counts.
    const second = await createApp(other.ctx, { name: "Second App", platforms: ["web"] });
    await expect(restoreApp(other.ctx, other.app.id)).rejects.toThrow(/plan/i);

    await archiveApp(other.ctx, second.id);
    await restoreApp(other.ctx, other.app.id);
    expect(await authenticateIngestionKey(prodKey)).not.toBeNull();
    expect((await listApps(other.ctx)).map((a) => a.id)).toEqual([other.app.id]);
    await expect(restoreApp(other.ctx, other.app.id)).rejects.toThrow(/not archived/);
    const actions = (await listAuditLogs(other.ctx, { area: "app" })).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["app.archived", "app.restored"]));
  });

  it("lets a viewer read projects but change nothing", async () => {
    const viewer = { ...t.ctx, role: "viewer" as const };
    expect((await listApps(viewer)).length).toBeGreaterThan(0);
    await expect(archiveApp(viewer, t.app.id)).rejects.toThrow(/permission/);
    await expect(setEnvironmentStatus(viewer, t.dev.id, "disabled")).rejects.toThrow(/permission/);
    await expect(listKeys(viewer, t.app.id)).rejects.toThrow(/permission/);
  });
});
