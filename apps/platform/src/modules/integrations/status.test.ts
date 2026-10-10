import { describe, expect, it } from "vitest";
import { addDays, deriveStatus, freshness, planSync, retryDelayMinutes } from "./status";

const d = (s: string) => new Date(s);

describe("capability status", () => {
  it("follows enabled → complete → last outcome", () => {
    const base = { enabled: true, complete: true, verifiedAt: null, lastSuccessAt: null, lastErrorAt: null };
    expect(deriveStatus({ ...base, enabled: false })).toBe("not_configured");
    expect(deriveStatus({ ...base, complete: false })).toBe("credentials_missing");
    expect(deriveStatus(base)).toBe("unverified");
    expect(deriveStatus({ ...base, verifiedAt: d("2026-10-01") })).toBe("verified");
    expect(deriveStatus({ ...base, lastSuccessAt: d("2026-10-01"), lastErrorAt: d("2026-10-02") })).toBe("error");
    expect(deriveStatus({ ...base, lastSuccessAt: d("2026-10-03"), lastErrorAt: d("2026-10-02") })).toBe("verified");
    // Missing credentials win over an old success: nothing can run.
    expect(deriveStatus({ ...base, complete: false, lastSuccessAt: d("2026-10-03") })).toBe("credentials_missing");
  });
});

describe("freshness", () => {
  it("is fresh within the lag, stale beyond it, none without data", () => {
    expect(freshness(null, "2026-10-09")).toEqual({ state: "none", lagDays: null });
    expect(freshness("2026-10-08", "2026-10-09")).toEqual({ state: "fresh", lagDays: 1 });
    expect(freshness("2026-10-05", "2026-10-09")).toEqual({ state: "stale", lagDays: 4 });
  });
});

describe("sync planning", () => {
  it("starts with the last 30 days, then re-imports the restatement window", () => {
    expect(planSync({ today: "2026-10-09", freshThrough: null, backfillFrom: null, backfillCursor: null })).toEqual({ kind: "incremental", from: "2026-09-10", to: "2026-10-09" });
    expect(planSync({ today: "2026-10-09", freshThrough: "2026-10-09", backfillFrom: null, backfillCursor: null })).toEqual({ kind: "incremental", from: "2026-10-06", to: "2026-10-09" });
    // After a long pause it catches up oldest chunk first, leaving no gap.
    expect(planSync({ today: "2026-10-09", freshThrough: "2026-06-01", backfillFrom: null, backfillCursor: null })).toEqual({ kind: "incremental", from: "2026-05-29", to: "2026-06-27" });
  });

  it("walks a backfill back in 30-day chunks to the requested day", () => {
    const s = { today: "2026-10-09", freshThrough: "2026-10-09", backfillFrom: "2026-08-01", backfillCursor: null as string | null };
    const first = planSync(s);
    expect(first).toEqual({ kind: "backfill", from: "2026-08-11", to: "2026-09-09" });
    const second = planSync({ ...s, backfillCursor: first.from });
    expect(second).toEqual({ kind: "backfill", from: "2026-08-01", to: "2026-08-10" });
    expect(planSync({ ...s, backfillCursor: second.from }).kind).toBe("incremental");
  });

  it("backs off 15 min → 1 h → 6 h → 24 h", () => {
    expect([1, 2, 3, 4, 9].map(retryDelayMinutes)).toEqual([15, 60, 360, 1440, 1440]);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
