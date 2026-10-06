import { describe, expect, it } from "vitest";
import { normalizeEvent } from "@/modules/ingestion/schema";
import { effectiveConsent, userKeyOf, userKeysOf, type StateRow } from "./consent";

const row = (user_key: string, purpose: StateRow["purpose"], granted: boolean, at: string): StateRow => ({ user_key, purpose, granted, updated_at: new Date(at) });

describe("consent stitching", () => {
  it("builds user keys like audiences and automation do", () => {
    expect(userKeyOf({ userId: "u1", anonymousId: "a1" })).toBe("u1");
    expect(userKeyOf({ anonymousId: "a1" })).toBe("anon:a1");
    expect(userKeyOf({})).toBeNull();
    expect(userKeysOf({ userId: "u1", anonymousId: "a1" })).toEqual(["u1", "anon:a1"]);
  });

  it("takes the most recent decision across the user and install keys", () => {
    const rows = [
      row("anon:a1", "analytics", false, "2026-10-01T10:00:00Z"),
      row("u1", "analytics", true, "2026-10-02T10:00:00Z"),
      row("u2", "analytics", false, "2026-10-03T10:00:00Z"),
      row("u1", "marketing", false, "2026-10-01T10:00:00Z"),
    ];
    expect(effectiveConsent(rows, ["u1", "anon:a1"], "analytics")).toBe(true);
    expect(effectiveConsent(rows, ["anon:a1"], "analytics")).toBe(false);
    expect(effectiveConsent(rows, ["u1"], "marketing")).toBe(false);
    expect(effectiveConsent(rows, ["u1"], "push")).toBeNull();
    expect(effectiveConsent(rows, ["nobody"], "analytics")).toBeNull();
  });
});

describe("consent wire format", () => {
  const opts = { now: new Date("2026-10-05T10:00:00Z"), fallbackEventId: () => "x" };
  it("accepts a consent event with known purposes", () => {
    const r = normalizeEvent({ type: "consent", anonymous_id: "a1", consent: { analytics: false, push: true } }, opts);
    expect(r.ok && r.event).toMatchObject({ type: "consent", event_name: "consent_updated", consent: { analytics: false, push: true } });
  });
  it("rejects empty, unknown or non-boolean purposes", () => {
    for (const consent of [undefined, {}, { tracking: true }, { analytics: 1 }]) {
      expect(normalizeEvent({ type: "consent", anonymous_id: "a1", consent }, opts).ok).toBe(false);
    }
  });
});
