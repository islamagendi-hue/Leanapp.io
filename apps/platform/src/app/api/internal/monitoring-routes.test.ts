import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every dependency of the two internal routes is mocked: no database, no network.
const captureException = vi.fn(async (..._args: unknown[]) => {});
const report = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/monitoring", () => ({ captureException, report }));
const checkWorkerHealth = vi.fn();
const alertOnProblems = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/server/worker-health", () => ({ checkWorkerHealth, alertOnProblems }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("@/server/config", () => ({ checkConfig: () => ({ deployment: "local", errors: [], warnings: [] }) }));
const processPendingEvents = vi.fn();
vi.mock("@/modules/processing/processor", () => ({ processPendingEvents }));
const runDeletionJobs = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ completed: 0 }));
vi.mock("@/modules/privacy/service", () => ({ runDeletionJobs }));
vi.mock("@/modules/reprocess/jobs", () => ({ runReprocessJobs: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ purgeRateLimitBuckets: async () => 0 }));
vi.mock("@/modules/maintenance/retention", () => ({ purgeOperationalData: async () => ({}), applyEventRetention: async () => ({ mode: "report", organizations: [] }) }));
vi.mock("@/modules/billing/notices", () => ({ sendUsageNotices: async () => ({ notices: 0, emails: 0 }) }));
vi.mock("@/modules/attribution/delivery", () => ({ runAttributionJobs: async () => null }));
vi.mock("@/modules/integrations/sync", () => ({ runAdSyncJobs: async () => null }));
vi.mock("@/modules/integrations/clarity-service", () => ({ runClaritySyncJobs: async () => null }));
const runEngagement = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("@/modules/automation/worker", () => ({ runEngagement }));
vi.mock("@/modules/media/service", () => ({ purgeDeletedMedia: async () => ({ purged: 0, kept: 0, failed: 0 }) }));
vi.mock("@/modules/marketing/demo", () => ({ demoEnabled: () => false, ensureDemo: async () => {} }));

const SECRET = "test-cron-secret-0123456789";
const req = (path: string, token?: string) => new Request(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("MONITORING_SECRET", "read-only-monitoring-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  runDeletionJobs.mockReset();
  runDeletionJobs.mockImplementation(async () => ({ completed: 0 }));
  runEngagement.mockReset();
  runEngagement.mockImplementation(async () => ({}));
});

describe("GET /api/internal/worker-status", () => {
  const ok = { status: "ok", problems: [], backlog: { oldest_unprocessed_age_seconds: 4, unprocessed: 1, unprocessed_capped: false, stale_after_seconds: 900 }, ingestion: { window_minutes: 15, requests: 3, server_errors: 0 }, scheduler: null };

  it("requires the monitoring or cron secret", async () => {
    const { GET } = await import("./worker-status/route");
    expect((await GET(req("/api/internal/worker-status"))).status).toBe(401);
    expect((await GET(req("/api/internal/worker-status", "wrong"))).status).toBe(401);
    checkWorkerHealth.mockResolvedValue(ok);
    expect((await GET(req("/api/internal/worker-status", "read-only-monitoring-secret"))).status).toBe(200);
    expect((await GET(req("/api/internal/worker-status", SECRET))).status).toBe(200);
    expect(alertOnProblems).not.toHaveBeenCalled();
  });

  it("returns 503 and alerts when degraded", async () => {
    const { GET } = await import("./worker-status/route");
    checkWorkerHealth.mockResolvedValue({ ...ok, status: "degraded", problems: ["backlog_stale"] });
    const res = await GET(req("/api/internal/worker-status", SECRET));
    expect(res.status).toBe(503);
    expect((await res.json()).problems).toEqual(["backlog_stale"]);
    expect(alertOnProblems).toHaveBeenCalledTimes(1);
  });

  it("reports a failing check without leaking the error", async () => {
    const { GET } = await import("./worker-status/route");
    checkWorkerHealth.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await GET(req("/api/internal/worker-status", SECRET));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unknown", error: "check_failed" });
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/internal/process-events monitoring", () => {
  it("reports a throwing step, still runs the remaining steps, and answers 500", async () => {
    const { GET } = await import("./process-events/route");
    const boom = new Error("processing exploded for user@example.com");
    processPendingEvents.mockRejectedValue(boom);
    checkWorkerHealth.mockResolvedValue({ status: "ok", problems: [] });
    const res = await GET(req("/api/internal/process-events", SECRET));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errors).toEqual([{ step: "processing", error_name: "Error" }]);
    expect(JSON.stringify(body)).not.toContain("exploded");
    expect(body).toMatchObject({ processed: 0, failed: 0, deletions: { completed: 0 } });
    expect(runEngagement).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ source: "worker:processing", details: { step: "processing" } }));
    await vi.waitFor(() => expect(alertOnProblems).toHaveBeenCalled());
  });

  it("isolates a failing deletions step: event processing and later steps still run", async () => {
    const { GET } = await import("./process-events/route");
    class DatabaseError extends Error {
      override name = "DatabaseError";
    }
    const boom = new DatabaseError("relation does not exist");
    runDeletionJobs.mockRejectedValue(boom);
    processPendingEvents.mockResolvedValue({ processed: 7, failed: 0 });
    checkWorkerHealth.mockResolvedValue({ status: "ok", problems: [] });
    const res = await GET(req("/api/internal/process-events", SECRET));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errors).toEqual([{ step: "deletions", error_name: "DatabaseError" }]);
    expect(body.deletions).toBeNull();
    expect(body.processed).toBe(7);
    expect(processPendingEvents).toHaveBeenCalledTimes(1);
    expect(runEngagement).toHaveBeenCalledTimes(1);
    expect(body.retention).toEqual({ mode: "report", organizations: [] });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ source: "worker:deletions", details: { step: "deletions" } }));
  });

  it("records every failing step", async () => {
    const { GET } = await import("./process-events/route");
    runDeletionJobs.mockRejectedValue(new Error("a"));
    runEngagement.mockRejectedValue(new TypeError("b"));
    processPendingEvents.mockResolvedValue({ processed: 1, failed: 0 });
    checkWorkerHealth.mockResolvedValue({ status: "ok", problems: [] });
    const res = await GET(req("/api/internal/process-events", SECRET));
    expect(res.status).toBe(500);
    expect((await res.json()).errors).toEqual([
      { step: "deletions", error_name: "Error" },
      { step: "engagement", error_name: "TypeError" },
    ]);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("returns 200 with an empty errors list on success and runs the heartbeat check afterwards", async () => {
    const { GET } = await import("./process-events/route");
    processPendingEvents.mockResolvedValue({ processed: 3, failed: 1 });
    checkWorkerHealth.mockResolvedValue({ status: "ok", problems: [] });
    const res = await GET(req("/api/internal/process-events", SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["attribution", "deletions", "demo", "engagement", "errors", "failed", "processed", "purged", "reprocess", "retention", "usage_notices"]);
    expect(body.errors).toEqual([]);
    await vi.waitFor(() => expect(alertOnProblems).toHaveBeenCalled());
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ key: "worker:events_failed", details: { failed: 1, processed: 3 } }));
    expect(captureException).not.toHaveBeenCalled();
  });

  it("refuses without the cron secret (the monitoring secret is read-only)", async () => {
    const { GET } = await import("./process-events/route");
    expect((await GET(req("/api/internal/process-events", "read-only-monitoring-secret"))).status).toBe(401);
  });
});
