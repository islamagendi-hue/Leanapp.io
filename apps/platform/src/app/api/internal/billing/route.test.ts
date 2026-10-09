import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No database, no network: the billing modules are mocked.
const billingStatus = vi.fn(async () => ({ state: "not_configured", mode: null, checkoutEnabled: false }));
const verifyBillingProvider = vi.fn(async (): Promise<unknown> => null);
vi.mock("@/modules/billing/status", () => ({ billingStatus, verifyBillingProvider }));
const reconcileSubscriptions = vi.fn(async () => ({ configured: false, checked: 0, applied: 0, unchanged: 0, failed: 0 }));
vi.mock("@/modules/billing/reconcile", () => ({ reconcileSubscriptions }));

const CRON = "test-cron-secret-0123456789";
const MONITOR = "read-only-monitoring-secret";
const get = (token?: string) => new Request("http://localhost/api/internal/billing", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (token: string | undefined, body: unknown) =>
  new Request("http://localhost/api/internal/billing", { method: "POST", body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("MONITORING_SECRET", MONITOR);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET/POST /api/internal/billing", () => {
  it("needs a bearer secret; the monitoring secret can only read", async () => {
    const { GET, POST } = await import("./route");
    expect((await GET(get())).status).toBe(401);
    expect((await GET(get("wrong"))).status).toBe(401);
    expect((await GET(get(MONITOR))).status).toBe(200);
    expect((await GET(get(CRON))).status).toBe(200);
    expect((await POST(post(MONITOR, { action: "verify" }))).status).toBe(401);
    expect(verifyBillingProvider).not.toHaveBeenCalled();
  });

  it("reports that verification and reconciliation can't run without keys", async () => {
    const { POST } = await import("./route");
    const v = await POST(post(CRON, { action: "verify" }));
    expect(v.status).toBe(409);
    expect(await v.json()).toMatchObject({ verified: false, status: { state: "not_configured" } });
    expect((await POST(post(CRON, { action: "reconcile" }))).status).toBe(409);
    expect((await POST(post(CRON, { action: "nope" }))).status).toBe(400);
  });

  it("returns the new status after a verification", async () => {
    verifyBillingProvider.mockResolvedValueOnce({ checkedAt: new Date(), ok: true, details: {} });
    const { POST } = await import("./route");
    const r = await POST(post(CRON, { action: "verify" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ verified: true });
  });
});
