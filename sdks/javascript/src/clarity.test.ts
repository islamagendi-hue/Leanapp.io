import { afterEach, describe, expect, it, vi } from "vitest";
import { ClarityBridge, clarityFunction } from "./clarity.js";
import { CLARITY_ANONYMOUS_TAG, LeanAppClient, memoryStorage } from "./index.js";

const KEY = "la_pk_dev_abcdefghijklmnopqrstuvwx";
const g = globalThis as { clarity?: unknown };

function web(opts: Partial<ConstructorParameters<typeof LeanAppClient>[0]> = {}) {
  let id = 0;
  return new LeanAppClient({
    apiKey: KEY,
    platform: "web",
    storage: memoryStorage(),
    flushAt: 1000,
    flushIntervalMs: 60_000,
    autoCapture: false,
    flushOnHide: false,
    uuid: () => `anon-${++id}`,
    fetch: (async () => new Response(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [] }))) as unknown as typeof fetch,
    ...opts,
  });
}

afterEach(() => {
  delete g.clarity;
});

describe("Clarity bridge (unit)", () => {
  it("finds window.clarity only when it is a function", () => {
    expect(clarityFunction({})).toBeNull();
    expect(clarityFunction({ clarity: "x" })).toBeNull();
    const fn = () => {};
    expect(clarityFunction({ clarity: fn })).toBe(fn);
  });

  it("calls identify and set once per identity, only on web, only with analytics consent", () => {
    const calls: unknown[][] = [];
    const bridge = new ClarityBridge(true, () => (...a: unknown[]) => calls.push(a));
    expect(bridge.sync({ platform: "ios", analytics: "granted", anonymousId: "a1" })).toBe(false);
    expect(bridge.sync({ platform: "web", analytics: "pending", anonymousId: "a1" })).toBe(false);
    expect(bridge.sync({ platform: "web", analytics: "denied", anonymousId: "a1" })).toBe(false);
    expect(calls).toEqual([]);
    expect(bridge.sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(true);
    expect(bridge.sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(false);
    expect(bridge.sync({ platform: "web", analytics: "granted", anonymousId: "a1", userId: "u7" })).toBe(true);
    expect(calls).toEqual([
      ["identify", "a1"], ["set", CLARITY_ANONYMOUS_TAG, "a1"],
      ["identify", "u7"], ["set", CLARITY_ANONYMOUS_TAG, "a1"],
    ]);
  });

  it("is off unless enabled, waits for the tag, and survives a broken tag", () => {
    const calls: unknown[][] = [];
    expect(new ClarityBridge(false, () => (...a: unknown[]) => calls.push(a)).sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(false);
    let fn: ((...a: unknown[]) => unknown) | null = null;
    const late = new ClarityBridge(true, () => fn);
    expect(late.sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(false);
    fn = (...a: unknown[]) => calls.push(a);
    expect(late.sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(true);
    expect(calls).toHaveLength(2);
    const broken = new ClarityBridge(true, () => () => { throw new Error("tag error"); });
    expect(broken.sync({ platform: "web", analytics: "granted", anonymousId: "a1" })).toBe(false);
  });
});

describe("Clarity bridge in the client", () => {
  it("does nothing by default, even with the tag on the page", async () => {
    const clarity = vi.fn();
    g.clarity = clarity;
    const c = web();
    await c.whenReady();
    c.identify("u1");
    c.track("signed_up");
    expect(clarity).not.toHaveBeenCalled();
    await c.shutdown();
  });

  it("identifies with the anonymous id, then the user id, and again after reset", async () => {
    const clarity = vi.fn();
    g.clarity = clarity;
    const c = web({ clarity: { enabled: true } });
    await c.whenReady();
    expect(clarity.mock.calls).toEqual([["identify", "anon-1"], ["set", "leanapp_anonymous_id", "anon-1"]]);
    c.track("viewed");
    expect(clarity).toHaveBeenCalledTimes(2);
    c.identify("user-42");
    expect(clarity.mock.calls.slice(2)).toEqual([["identify", "user-42"], ["set", "leanapp_anonymous_id", "anon-1"]]);
    c.reset();
    const anon = c.getAnonymousId();
    expect(clarity.mock.calls.slice(4)).toEqual([["identify", anon], ["set", "leanapp_anonymous_id", anon]]);
    await c.shutdown();
  });

  it("waits for analytics consent and never sends Clarity a consent signal", async () => {
    const clarity = vi.fn();
    g.clarity = clarity;
    const c = web({ clarity: { enabled: true }, consentDefault: "pending" });
    await c.whenReady();
    c.identify("user-1");
    expect(clarity).not.toHaveBeenCalled();
    c.setConsent({ analytics: false });
    expect(clarity).not.toHaveBeenCalled();
    c.setConsent({ analytics: true });
    expect(clarity.mock.calls).toEqual([["identify", "user-1"], ["set", "leanapp_anonymous_id", "anon-1"]]);
    expect(clarity.mock.calls.some((call) => String(call[0]).startsWith("consent"))).toBe(false);
    await c.shutdown();
  });

  it("picks up a Clarity tag that loads after the SDK on the next call", async () => {
    const c = web({ clarity: { enabled: true } });
    await c.whenReady();
    const clarity = vi.fn();
    g.clarity = clarity;
    c.track("page_viewed");
    expect(clarity.mock.calls[0]).toEqual(["identify", "anon-1"]);
    await c.shutdown();
  });

  it("stays off outside browsers", async () => {
    const clarity = vi.fn();
    g.clarity = clarity;
    const c = web({ platform: "react_native", clarity: { enabled: true } });
    await c.whenReady();
    c.identify("u1");
    expect(clarity).not.toHaveBeenCalled();
    await c.shutdown();
  });
});
