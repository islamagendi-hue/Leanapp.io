import { describe, expect, it } from "vitest";
import { BACKLOG_STALE_SECONDS, SCHEDULER_STALE_SECONDS, evaluate, type WorkerSignals } from "./worker-health";

const healthy: WorkerSignals = {
  oldestUnprocessedAgeSeconds: 30,
  unprocessed: 12,
  ingestRequests: 1000,
  ingest5xx: 2,
  scheduler: { lastRunAgeSeconds: 120, lastRunStatus: "succeeded", lastHttpStatus: 200, lastHttpError: false },
};

describe("worker health", () => {
  it("is ok when the backlog is fresh, 5xx are rare and the scheduler ran recently", () => {
    expect(evaluate(healthy)).toMatchObject({ status: "ok", problems: [] });
    expect(evaluate({ ...healthy, oldestUnprocessedAgeSeconds: null, unprocessed: 0, scheduler: null }).status).toBe("ok");
  });

  it("flags a stale backlog past the threshold", () => {
    const h = evaluate({ ...healthy, oldestUnprocessedAgeSeconds: BACKLOG_STALE_SECONDS + 1 });
    expect(h.status).toBe("degraded");
    expect(h.problems).toEqual(["backlog_stale"]);
  });

  it("flags an elevated ingestion 5xx rate only above both the count and the rate", () => {
    expect(evaluate({ ...healthy, ingestRequests: 10, ingest5xx: 4 }).problems).toEqual([]); // 40%, but only 4
    expect(evaluate({ ...healthy, ingestRequests: 10_000, ingest5xx: 100 }).problems).toEqual([]); // 1%
    expect(evaluate({ ...healthy, ingestRequests: 100, ingest5xx: 5 }).problems).toEqual(["ingestion_5xx_rate"]);
  });

  it("flags a scheduler that stopped, is missing, or got a non-200", () => {
    expect(evaluate({ ...healthy, scheduler: { ...healthy.scheduler!, lastRunAgeSeconds: SCHEDULER_STALE_SECONDS + 1 } }).problems).toEqual(["scheduler_stale"]);
    expect(evaluate({ ...healthy, scheduler: { lastRunAgeSeconds: null, lastRunStatus: "job_missing", lastHttpStatus: null, lastHttpError: false } }).problems).toEqual(["scheduler_stale"]);
    expect(evaluate({ ...healthy, scheduler: { ...healthy.scheduler!, lastHttpStatus: 401 } }).problems).toEqual(["scheduler_http_error"]);
    expect(evaluate({ ...healthy, scheduler: { ...healthy.scheduler!, lastHttpStatus: null, lastHttpError: true } }).problems).toEqual(["scheduler_http_error"]);
  });

  it("caps the reported backlog count and exposes aggregates only", () => {
    const h = evaluate({ ...healthy, unprocessed: 10_000 });
    expect(h.backlog).toMatchObject({ unprocessed: 10_000, unprocessed_capped: true });
    expect(Object.keys(h).sort()).toEqual(["backlog", "ingestion", "problems", "scheduler", "status"]);
  });
});
