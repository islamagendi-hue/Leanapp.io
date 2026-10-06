import { describe, expect, it } from "vitest";
import { localParts, nextScheduled, quietHoursEnd, zonedTime } from "./time";

describe("time zones", () => {
  it("converts local wall time to instants", () => {
    expect(zonedTime(2026, 3, 1, 9, 0, "Asia/Riyadh").toISOString()).toBe("2026-03-01T06:00:00.000Z");
    expect(zonedTime(2026, 7, 1, 9, 0, "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(localParts(new Date("2026-03-01T21:30:00Z"), "Asia/Dubai")).toMatchObject({ day: 2, hour: 1, minute: 30 });
  });

  it("finds the end of quiet hours across midnight", () => {
    const q = { start: "22:00", end: "08:00" };
    // 23:30 Riyadh (UTC+3) → 08:00 next day Riyadh = 05:00Z
    expect(quietHoursEnd(new Date("2026-03-01T20:30:00Z"), "Asia/Riyadh", q)?.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    // 02:00 Riyadh → 08:00 same day
    expect(quietHoursEnd(new Date("2026-03-01T23:00:00Z"), "Asia/Riyadh", q)?.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    // 12:00 Riyadh: not quiet
    expect(quietHoursEnd(new Date("2026-03-01T09:00:00Z"), "Asia/Riyadh", q)).toBeNull();
    // Same-day window
    expect(quietHoursEnd(new Date("2026-03-01T10:30:00Z"), "UTC", { start: "10:00", end: "11:00" })?.toISOString()).toBe("2026-03-01T11:00:00.000Z");
    expect(quietHoursEnd(new Date("2026-03-01T11:00:00Z"), "UTC", { start: "10:00", end: "11:00" })).toBeNull();
  });

  it("computes the next daily and weekly slot", () => {
    expect(nextScheduled(new Date("2026-03-01T05:00:00Z"), "Asia/Riyadh", { every: "day", at: "09:00" }).toISOString()).toBe("2026-03-01T06:00:00.000Z");
    expect(nextScheduled(new Date("2026-03-01T06:00:00Z"), "Asia/Riyadh", { every: "day", at: "09:00" }).toISOString()).toBe("2026-03-02T06:00:00.000Z");
    // 2026-03-01 is a Sunday; next Friday (5) is 03-06.
    expect(nextScheduled(new Date("2026-03-01T05:00:00Z"), "Asia/Riyadh", { every: "week", at: "18:30", weekday: 5 }).toISOString()).toBe("2026-03-06T15:30:00.000Z");
  });
});
