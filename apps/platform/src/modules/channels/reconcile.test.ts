import { describe, expect, it } from "vitest";
import { classifyTouch } from "./classify";
import { normalizeTouch } from "./normalize";
import { costPer, reconcileSpend, type SpendEntry } from "./reconcile";

const channelOf = (source: string) => classifyTouch(normalizeTouch({ utm_source: source })).channel;
const e = (o: Partial<SpendEntry>): SpendEntry => ({ day: "2026-10-01", source: "tiktok", campaign: "", currency: "SAR", amount: 100, ...o });

describe("reconcileSpend", () => {
  it("S1: campaign rows replace the whole-source row of the same day", () => {
    const r = reconcileSpend([e({ amount: 300 }), e({ campaign: "a", amount: 120 }), e({ campaign: "b", amount: 80 }), e({ day: "2026-10-02", amount: 50 })], channelOf);
    expect(r.byChannel.get("tiktok_ads")?.get("SAR")).toBe(250);
    expect(r.issues).toEqual([{ rule: "S1", day: "2026-10-01", source: "tiktok", currency: "SAR", excluded: 300 }]);
  });

  it("S2: the same amount under two spellings of one channel counts once; different amounts both count", () => {
    const dup = reconcileSpend([e({ source: "facebook", amount: 70 }), e({ source: "meta", amount: 70 })], channelOf);
    expect(dup.byChannel.get("meta_ads")?.get("SAR")).toBe(70);
    expect(dup.issues[0]).toMatchObject({ rule: "S2", channel: "meta_ads", sources: ["facebook", "meta"], excluded: 70 });
    const both = reconcileSpend([e({ source: "facebook", amount: 70 }), e({ source: "instagram", amount: 30 })], channelOf);
    expect(both.byChannel.get("meta_ads")?.get("SAR")).toBe(100);
    expect(both.issues).toEqual([]);
  });

  it("S3/S4: currencies stay apart and unknown sources stay on their own row", () => {
    const r = reconcileSpend([e({ currency: "USD", amount: 10 }), e({ amount: 20 }), e({ source: "mystery_dsp", amount: 5 })], channelOf);
    expect(Object.fromEntries(r.byChannel.get("tiktok_ads")!)).toEqual({ SAR: 20, USD: 10 });
    expect(r.byChannel.get("unknown")?.get("SAR")).toBe(5);
  });
});

describe("costPer", () => {
  it("divides per currency and is empty without results or spend", () => {
    expect(costPer(new Map([["SAR", 100], ["USD", 0]]), 4)).toEqual([{ currency: "SAR", amount: 25 }]);
    expect(costPer(new Map([["SAR", 100]]), 0)).toEqual([]);
    expect(costPer(undefined, 3)).toEqual([]);
  });
});
