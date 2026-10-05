import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics, LeanAppClient, memoryStorage, parseAttribution, type StorageAdapter, type WireEvent } from "./index.js";

const KEY = "la_pk_dev_abcdefghijklmnopqrstuvwx";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { batch: WireEvent[]; sent_at: string };
}

function server(responder: (call: Call, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } | Error = () => ({ status: 200 })) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    calls.push(call);
    const r = responder(call, calls.length);
    if (r instanceof Error) throw r;
    const body = r.body ?? { accepted: call.body.batch.length, duplicates: 0, rejected: [] };
    return new Response(JSON.stringify(body), { status: r.status, headers: r.headers });
  });
  return { calls, fetch: fetchFn as unknown as typeof fetch };
}

function make(opts: Partial<ConstructorParameters<typeof LeanAppClient>[0]> = {}) {
  let t = Date.parse("2026-10-05T10:00:00Z");
  let id = 0;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const client = new LeanAppClient({
    apiKey: KEY,
    platform: "react_native",
    appVersion: "2.3.0",
    storage: memoryStorage(),
    flushAt: 1000,
    flushIntervalMs: 60_000,
    now: clock.now,
    uuid: () => `id-${++id}`,
    random: () => 0.5,
    ...opts,
  });
  return { client, clock };
}

afterEach(async () => {
  vi.useRealTimers();
  await Analytics._reset();
});

describe("configuration", () => {
  it("rejects keys that are not LeanApp keys", () => {
    expect(() => new LeanAppClient({ apiKey: "sk_live_123" })).toThrow(/la_pk_/);
  });
  it("refuses a secret key outside a server", () => {
    expect(() => new LeanAppClient({ apiKey: "la_sk_dev_" + "x".repeat(40), platform: "ios" })).toThrow(/servers only/);
    expect(() => new LeanAppClient({ apiKey: "la_sk_dev_" + "x".repeat(40), platform: "backend", storage: memoryStorage() })).not.toThrow();
  });
  it("defaults to the LeanApp API", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, endpoint: undefined });
    client.track("app_opened");
    await client.flush();
    expect(s.calls[0].url).toBe("https://api.leanapp.io/v1/events/batch");
  });
});

describe("events", () => {
  it("sends batched events with identity, session and context", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, endpoint: "https://api.example.test/" });
    client.track("product_viewed", { product_id: "p1" });
    client.screen("Home");
    client.identify("u-42", { city: "Riyadh" });
    client.track("order_completed", { order_id: "o1", revenue: 45, currency: "SAR" }, { eventId: "order-o1" });
    const r = await client.flush();
    expect(r).toMatchObject({ status: "sent", accepted: 4 });
    expect(s.calls).toHaveLength(1);
    const { url, headers, body } = s.calls[0];
    expect(url).toBe("https://api.example.test/v1/events/batch");
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Idempotency-Key"]).toBeTruthy();
    const [view, screen, identify, order] = body.batch;
    expect(view).toMatchObject({ type: "track", event_name: "product_viewed", properties: { product_id: "p1" }, anonymous_id: "id-1" });
    expect(view.user_id).toBeUndefined();
    expect(view.context).toMatchObject({ platform: "react_native", app_version: "2.3.0", sdk: { name: "leanapp-js", version: "0.1.0" } });
    expect(screen).toMatchObject({ type: "screen", event_name: "Home", properties: { screen_name: "Home" } });
    expect(identify).toMatchObject({ type: "identify", user_id: "u-42", user_properties: { city: "Riyadh" } });
    expect(order).toMatchObject({ event_id: "order-o1", user_id: "u-42", anonymous_id: "id-1" });
    expect(new Set(body.batch.map((e) => e.session_id)).size).toBe(1);
    expect(client.queueLength).toBe(0);
  });

  it("ignores a second event with the same event id while it is queued", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.track("order_completed", { order_id: "o1" }, { eventId: "order-o1" });
    client.track("order_completed", { order_id: "o1" }, { eventId: "order-o1" });
    await client.whenReady();
    expect(client.queueLength).toBe(1);
  });

  it("starts a new session after 30 minutes of inactivity", async () => {
    const s = server();
    const { client, clock } = make({ fetch: s.fetch });
    client.track("a");
    clock.advance(29 * 60_000);
    client.track("b");
    clock.advance(31 * 60_000);
    client.track("c");
    await client.flush();
    const [a, b, c] = s.calls[0].body.batch;
    expect(a.session_id).toBe(b.session_id);
    expect(c.session_id).not.toBe(b.session_id);
  });

  it("splits large queues into batches", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, maxBatchSize: 2 });
    for (let i = 0; i < 5; i++) client.track(`e${i}`);
    await client.flush();
    expect(s.calls.map((c) => c.body.batch.length)).toEqual([2, 2, 1]);
  });

  it("reset() forgets the user and starts a new anonymous id", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.identify("u-1");
    client.reset();
    client.track("app_opened");
    await client.flush();
    const last = s.calls[0].body.batch[s.calls[0].body.batch.length - 1];
    expect(last.user_id).toBeUndefined();
    expect(last.anonymous_id).not.toBe(s.calls[0].body.batch[0].anonymous_id);
  });

  it("registers push tokens and aliases", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.registerPushToken("fcm-token-1234567890", "fcm", "granted");
    client.alias("u-9", "guest-1");
    await client.flush();
    const [push, alias] = s.calls[0].body.batch;
    expect(push).toMatchObject({ type: "push_token", push_token: { token: "fcm-token-1234567890", provider: "fcm", permission: "granted" } });
    expect(alias).toMatchObject({ type: "alias", previous_id: "guest-1", user_id: "u-9" });
  });
});

describe("delivery", () => {
  it("keeps events offline, retries with backoff and survives a restart", async () => {
    const storage = memoryStorage();
    let online = false;
    const s = server(() => (online ? { status: 200 } : new TypeError("Network request failed")));
    const first = make({ fetch: s.fetch, storage });
    first.client.track("app_opened");
    first.client.track("product_viewed");
    const r1 = await first.client.flush();
    expect(r1).toMatchObject({ status: "retry", retryInMs: 750 }); // 1s base, jittered to 75% with random 0.5
    const r2 = await first.client.flush();
    expect(r2.status === "retry" && r2.retryInMs).toBe(1500);
    expect(first.client.queueLength).toBe(2);
    await first.client.shutdown();

    online = true;
    const second = make({ fetch: s.fetch, storage });
    expect(await second.client.flush()).toMatchObject({ status: "sent", accepted: 2 });
    const sent = s.calls[s.calls.length - 1].body.batch;
    expect(sent.map((e) => e.event_name)).toEqual(["app_opened", "product_viewed"]);
    // Same ids as the failed attempts, so the server de-duplicates if one of them actually landed.
    expect(sent.map((e) => e.event_id)).toEqual(s.calls[0].body.batch.map((e) => e.event_id));
    expect(s.calls[s.calls.length - 1].headers["Idempotency-Key"]).toBe(s.calls[0].headers["Idempotency-Key"]);
  });

  it("honours Retry-After on 429", async () => {
    const s = server(() => ({ status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "7" } }));
    const { client } = make({ fetch: s.fetch });
    client.track("a");
    expect(await client.flush()).toMatchObject({ status: "retry", retryInMs: 7000 });
    expect(client.queueLength).toBe(1);
  });

  it("stops sending but keeps events when the key is revoked", async () => {
    const s = server(() => ({ status: 401, body: { error: "invalid_api_key" } }));
    const { client } = make({ fetch: s.fetch });
    client.track("a");
    expect(await client.flush()).toEqual({ status: "unauthorized" });
    expect(await client.flush()).toEqual({ status: "unauthorized" });
    expect(s.calls).toHaveLength(1);
    expect(client.queueLength).toBe(1);
  });

  it("drops a batch the server says is malformed instead of retrying forever", async () => {
    const s = server(() => ({ status: 400, body: { error: "invalid_batch" } }));
    const { client } = make({ fetch: s.fetch });
    client.track("a");
    await client.flush();
    expect(client.queueLength).toBe(0);
  });

  it("removes events the server rejected individually along with the accepted ones", async () => {
    const s = server((c) => ({ status: 200, body: { accepted: c.body.batch.length - 1, duplicates: 0, rejected: [{ index: 0, errors: [{ field: "timestamp", message: "too old" }] }] } }));
    const { client } = make({ fetch: s.fetch });
    client.track("a");
    client.track("b");
    expect(await client.flush()).toMatchObject({ status: "sent", accepted: 1, rejected: 1 });
    expect(client.queueLength).toBe(0);
  });

  it("caps the queue and expires old events", async () => {
    const s = server();
    const { client, clock } = make({ fetch: s.fetch, maxQueueSize: 10, eventTtlMs: 60_000 });
    for (let i = 0; i < 15; i++) client.track(`e${i}`);
    await client.whenReady();
    expect(client.queueLength).toBe(10);
    clock.advance(61_000);
    client.track("fresh");
    await client.flush();
    expect(s.calls[0].body.batch.map((e) => e.event_name)).toEqual(["fresh"]);
  });

  it("does not send while opted out", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, optedOut: true });
    client.track("a");
    expect(await client.flush()).toEqual({ status: "paused" });
    expect(s.calls).toHaveLength(0);
  });

  it("buffers calls made before slow storage has loaded", async () => {
    const mem = memoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: StorageAdapter = { ...mem, getItem: async (k) => (await gate, mem.getItem(k)) };
    const s = server();
    const { client } = make({ fetch: s.fetch, storage: slow });
    client.track("early");
    expect(client.queueLength).toBe(0);
    release();
    await client.flush();
    expect(s.calls[0].body.batch.map((e) => e.event_name)).toEqual(["early"]);
  });

  it("flushes automatically once flushAt events are queued", async () => {
    vi.useFakeTimers();
    const s = server();
    const { client } = make({ fetch: s.fetch, flushAt: 3 });
    await client.whenReady();
    client.track("a");
    client.track("b");
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls).toHaveLength(0);
    client.track("c");
    await vi.advanceTimersByTimeAsync(10);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].body.batch).toHaveLength(3);
  });
});

describe("attribution", () => {
  it("parses campaign parameters and click ids", () => {
    expect(parseAttribution("myapp://open?utm_source=tiktok&utm_campaign=ramadan%20sale&ttclid=abc&foo=1")).toEqual({ utm_source: "tiktok", utm_campaign: "ramadan sale", ttclid: "abc" });
    expect(parseAttribution("https://x.test/?sccid=snap1")).toEqual({ ScCid: "snap1" });
    expect(parseAttribution("https://x.test/home")).toBeNull();
  });

  it("keeps the first touch and attaches the latest to events", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.captureAttribution("https://leanapp.io/l?utm_source=snapchat&ScCid=s1");
    client.captureAttribution("https://leanapp.io/l?utm_source=tiktok&ttclid=t1");
    client.track("app_opened");
    await client.flush();
    expect(client.getAttribution()).toEqual({ first: { utm_source: "snapchat", ScCid: "s1" }, latest: { utm_source: "tiktok", ttclid: "t1" } });
    expect(s.calls[0].body.batch[0].context.attribution).toEqual({ utm_source: "tiktok", ttclid: "t1" });
  });
});

describe("singleton", () => {
  it("is safe to call before initialize and initializes once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => Analytics.track("ignored")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const s = server();
    const a = Analytics.initialize({ apiKey: KEY, platform: "web", storage: memoryStorage(), fetch: s.fetch });
    expect(Analytics.initialize({ apiKey: KEY })).toBe(a);
    Analytics.track("app_opened");
    await Analytics.flush();
    expect(s.calls[0].body.batch[0].event_name).toBe("app_opened");
    warn.mockRestore();
  });
});
