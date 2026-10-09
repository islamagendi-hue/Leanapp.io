import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics, LeanAppClient, memoryStorage, parseAttribution, storagePrefix, type StorageAdapter, type WireEvent } from "./index.js";
import { eventIdsHash, idempotencyKey } from "./client.js";

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
    // batch size : hash of every event id : first event id
    expect(headers["Idempotency-Key"]).toBe(`4:${eventIdsHash(body.batch.map((e) => e.event_id))}:id-2`);
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

  it("derives the Idempotency-Key from every event id in the batch", () => {
    // FNV-1a 32-bit over the UTF-8 ids joined by "\n"; the Android, iOS and Flutter SDKs test the same vectors.
    expect(eventIdsHash(["a"])).toBe("e40c292c");
    expect(eventIdsHash(["a", "b"])).toBe("28e4c710");
    expect(eventIdsHash(["é😀"])).toBe("039d63cc");
    expect(idempotencyKey(["id-2", "id-3"])).toBe("2:408dab4a:id-2");
    // Same first id and size but different events (the queue changed before a retry): different key.
    expect(idempotencyKey(["A", "B"])).not.toBe(idempotencyKey(["A", "C"]));
    expect(idempotencyKey(["A", "B"])).not.toBe(idempotencyKey(["B", "A"]));
    expect(idempotencyKey(["A", "B"])).toBe(idempotencyKey(["A", "B"]));
  });

  it("resends without the Idempotency-Key when the server says the key was used for other events", async () => {
    const s = server((_c, n) => (n === 1 ? { status: 409, body: { error: "idempotency_key_reused" } } : { status: 200 }));
    const { client } = make({ fetch: s.fetch });
    client.track("a");
    client.track("b");
    expect(await client.flush()).toMatchObject({ status: "retry", retryInMs: 0 });
    expect(client.queueLength).toBe(2); // never dropped
    expect(await client.flush()).toMatchObject({ status: "sent", accepted: 2 });
    expect(s.calls[1].headers["Idempotency-Key"]).toBeUndefined();
    expect(s.calls[1].body.batch.map((e) => e.event_id)).toEqual(s.calls[0].body.batch.map((e) => e.event_id));
    expect(client.queueLength).toBe(0);
    // Later batches carry a key again.
    client.track("c");
    await client.flush();
    expect(s.calls[2].headers["Idempotency-Key"]).toMatch(/^1:[0-9a-f]{8}:/);
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

describe("storage namespace", () => {
  const ROTATED = "la_pk_dev_zyxwvutsrqponmlkjihgfedc";

  it("depends only on the key kind and environment, not the random part", () => {
    expect(storagePrefix(KEY)).toBe("leanapp:la_pk_dev:");
    expect(storagePrefix(ROTATED)).toBe(storagePrefix(KEY));
    expect(storagePrefix("la_pk_live_abcdefghijklmnopqrstuvwx")).toBe("leanapp:la_pk_live:");
  });

  it("keeps the anonymous id and queue when the key is rotated", async () => {
    const storage = memoryStorage();
    const first = make({ storage, fetch: server(() => new TypeError("offline")).fetch });
    first.client.track("queued_before_rotation");
    await first.client.whenReady();
    const anonymousId = first.client.getAnonymousId();
    await first.client.shutdown();

    const s = server();
    const second = make({ storage, apiKey: ROTATED, fetch: s.fetch });
    await second.client.whenReady();
    expect(second.client.getAnonymousId()).toBe(anonymousId);
    await second.client.flush();
    expect(s.calls[0].body.batch.map((e) => e.event_name)).toEqual(["queued_before_rotation"]);
  });

  it("moves data from the old key-specific namespace once", async () => {
    const storage = memoryStorage();
    const legacy = `leanapp:${KEY.slice(0, 14)}:`;
    const queued: WireEvent = { type: "track", event_name: "old", event_id: "old-1", timestamp: "2026-10-05T09:00:00.000Z", anonymous_id: "anon-legacy", context: {} };
    await storage.setItem(legacy + "state", JSON.stringify({ anonymousId: "anon-legacy", userId: "u1" }));
    await storage.setItem(legacy + "queue", JSON.stringify([{ e: queued, queuedAt: Date.parse("2026-10-05T09:00:00Z") }]));

    const s = server();
    const { client } = make({ storage, fetch: s.fetch });
    await client.whenReady();
    expect(client.getAnonymousId()).toBe("anon-legacy");
    expect(client.getUserId()).toBe("u1");
    expect(client.queueLength).toBe(1);
    await client.shutdown();
    expect(await storage.getItem(legacy + "state")).toBeNull();
    expect(await storage.getItem(legacy + "queue")).toBeNull();
    expect(JSON.parse((await storage.getItem("leanapp:la_pk_dev:state"))!).anonymousId).toBe("anon-legacy");

    // A second start reads the new namespace and does not migrate again.
    await storage.setItem(legacy + "state", JSON.stringify({ anonymousId: "anon-stale" }));
    const again = make({ storage, fetch: s.fetch });
    await again.client.whenReady();
    expect(again.client.getAnonymousId()).toBe("anon-legacy");
  });
});

describe("lifecycle flush", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function browser() {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
    vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
    const inits: RequestInit[] = [];
    const s = server();
    const fetchFn = ((url: string, init: RequestInit) => {
      inits.push(init);
      return s.fetch(url, init);
    }) as typeof fetch;
    return {
      fetch: fetchFn,
      calls: s.calls,
      inits,
      hide() {
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
      },
      pagehide: () => win.dispatchEvent(new Event("pagehide")),
    };
  }

  it("sends queued events with keepalive when the page is hidden", async () => {
    const b = browser();
    const { client } = make({ platform: "web", fetch: b.fetch });
    await client.whenReady();
    client.track("checkout_started");
    b.hide();
    await vi.waitFor(() => expect(client.queueLength).toBe(0));
    expect(b.calls[0].body.batch[0].event_name).toBe("checkout_started");
    expect(b.inits[0].keepalive).toBe(true);
    await client.shutdown();
  });

  it("sends on pagehide and keeps each keepalive request under 64 KiB", async () => {
    const b = browser();
    const { client } = make({ platform: "web", fetch: b.fetch });
    await client.whenReady();
    for (let i = 0; i < 40; i++) client.track("big", { blob: "x".repeat(3_000) });
    b.pagehide();
    await vi.waitFor(() => expect(b.calls.length).toBe(1));
    expect(new TextEncoder().encode(b.inits[0].body as string).length).toBeLessThan(64 * 1024);
    expect(b.calls[0].body.batch.length).toBeLessThan(40);
    await vi.waitFor(() => expect(client.queueLength).toBe(40 - b.calls[0].body.batch.length));
    await client.shutdown();
  });

  it("can be turned off and stops listening on shutdown", async () => {
    const b = browser();
    const off = make({ platform: "web", fetch: b.fetch, flushOnHide: false });
    await off.client.whenReady();
    off.client.track("a");
    b.hide();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.calls.length).toBe(0);
    await off.client.shutdown();
  });

  it("flushes when a React Native app goes to the background", async () => {
    let listener: ((state: string) => void) | null = null;
    const remove = vi.fn();
    const appState = {
      addEventListener: (_type: "change", l: (state: string) => void) => {
        listener = l;
        return { remove };
      },
    };
    const s = server();
    const { client } = make({ fetch: s.fetch, appState });
    await client.whenReady();
    client.track("cart_viewed");
    listener!("inactive");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.length).toBe(0);
    listener!("background");
    await vi.waitFor(() => expect(s.calls.length).toBe(1));
    expect(s.calls[0].body.batch[0].event_name).toBe("cart_viewed");
    await client.shutdown();
    expect(remove).toHaveBeenCalled();
  });
});

describe("consent", () => {
  const types = (calls: { body: { batch: WireEvent[] } }[]) => calls.flatMap((c) => c.body.batch.map((e) => (e.type === "track" ? e.event_name : e.type)));

  it("defaults to granted, so apps that never call setConsent behave as before", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    expect(client.getConsent()).toEqual({ analytics: "granted", marketing: "granted", push: "granted", attribution: "granted" });
    client.track("a");
    await client.flush();
    expect(types(s.calls)).toEqual(["a"]);
  });

  it("pending: holds events in memory only, then sends them once analytics is granted", async () => {
    const s = server();
    const storage = memoryStorage();
    const { client } = make({ fetch: s.fetch, storage, consentDefault: "pending" });
    client.track("a");
    client.screen("Home");
    expect(await client.flush()).toEqual({ status: "empty" });
    expect(s.calls).toHaveLength(0);
    expect(client.queueLength).toBe(0);
    await client.shutdown();
    // Nothing waiting for consent is written to the device.
    expect(await storage.getItem(`${storagePrefix(KEY)}queue`)).toBe("[]");

    client.setConsent({ analytics: true, marketing: false });
    await client.flush();
    expect(types(s.calls)).toEqual(["consent", "a", "screen"]);
    const c = s.calls[0].body.batch[0];
    expect(c.consent).toEqual({ analytics: true, marketing: false });
    expect(c.session_id).toBeUndefined();
    expect(c.context.attribution).toBeUndefined();
    expect(client.getConsent()).toMatchObject({ analytics: "granted", marketing: "denied", push: "pending" });
  });

  it("pending events are lost if the app closes before the user decides", async () => {
    const storage = memoryStorage();
    const first = make({ storage, consentDefault: "pending" }).client;
    first.track("a");
    await first.whenReady();
    await first.shutdown();
    const s = server();
    const second = make({ storage, fetch: s.fetch, consentDefault: "pending" }).client;
    second.setConsent({ analytics: true });
    await second.flush();
    expect(types(s.calls)).toEqual(["consent"]);
  });

  it("denied: discards held and queued events but still sends the consent change", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, consentDefault: { analytics: "pending" } });
    client.track("held");
    client.setConsent({ analytics: true });
    client.track("queued");
    client.setConsent({ analytics: false });
    client.track("after");
    await client.flush();
    // Only the consent changes go out: "queued" was discarded with the denial, "after" never queued.
    expect(types(s.calls)).toEqual(["consent", "consent"]);
    expect(s.calls[0].body.batch.map((e) => e.consent)).toEqual([{ analytics: true }, { analytics: false }]);
  });

  it("an explicit default of denied drops events without sending anything", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, consentDefault: "denied" });
    client.track("a");
    client.registerPushToken("t".repeat(20), "fcm");
    expect(await client.flush()).toEqual({ status: "empty" });
    expect(s.calls).toHaveLength(0);
  });

  it("persists the answer across restarts and purges unsent events on load after a denial", async () => {
    const storage = memoryStorage();
    const s = server(() => new Error("offline"));
    const first = make({ storage, fetch: s.fetch }).client;
    first.track("before");
    first.setConsent({ analytics: false, push: true });
    await first.flush();
    await first.shutdown();

    const s2 = server();
    const second = make({ storage, fetch: s2.fetch, consentDefault: "pending" }).client;
    await second.whenReady();
    expect(second.getConsent()).toMatchObject({ analytics: "denied", push: "granted", marketing: "pending" });
    second.track("ignored");
    second.registerPushToken("t".repeat(20), "fcm", "granted");
    await second.flush();
    expect(types(s2.calls)).toEqual(["consent", "push_token"]);
  });

  it("push and attribution are separate purposes", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch, consentDefault: { push: "pending", attribution: "pending" } });
    client.captureAttribution("https://x.test/?utm_source=tiktok");
    client.registerPushToken("t".repeat(20), "fcm");
    client.track("a");
    await client.flush();
    expect(types(s.calls)).toEqual(["a"]);
    expect(s.calls[0].body.batch[0].context.attribution).toBeUndefined();
    expect(client.getAttribution()).toBeNull();

    client.setConsent({ push: true, attribution: true });
    client.track("b");
    await client.flush();
    const sent = s.calls[1].body.batch;
    expect(sent.map((e) => e.type)).toEqual(["consent", "push_token", "track"]);
    expect(sent[2].context.attribution).toMatchObject({ utm_source: "tiktok" });

    client.setConsent({ attribution: false });
    client.track("c");
    await client.flush();
    const last = s.calls[2].body.batch;
    expect(last[last.length - 1].context.attribution).toBeUndefined();
    expect(client.getAttribution()).toBeNull();
  });

  it("records the device's consent for a user who signs in, and for the new id after reset", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.setConsent({ marketing: false });
    client.identify("u1");
    client.identify("u1"); // same user: nothing new to record
    client.reset();
    await client.flush();
    const consents = s.calls.flatMap((c) => c.body.batch).filter((e) => e.type === "consent");
    expect(consents.map((e) => [e.user_id ?? null, e.consent])).toEqual([
      [null, { marketing: false }],
      ["u1", { marketing: false }],
      [null, { marketing: false }],
    ]);
    expect(consents[2].anonymous_id).not.toBe(consents[0].anonymous_id);
    expect(client.getConsent().marketing).toBe("denied");
  });

  it("ignores calls without a boolean purpose and is exposed on the singleton", async () => {
    const s = server();
    const { client } = make({ fetch: s.fetch });
    client.setConsent({} as never);
    client.setConsent({ analytics: "yes" } as never);
    expect(await client.flush()).toEqual({ status: "empty" });

    Analytics.initialize({ apiKey: KEY, platform: "react_native", storage: memoryStorage(), fetch: s.fetch, consentDefault: "pending" });
    Analytics.setConsent({ analytics: true });
    expect(Analytics.getConsent()).toMatchObject({ analytics: "granted", marketing: "pending" });
  });
});

describe("experiments", () => {
  /** A server that answers assignments with `variants` (experiment key → variant) and accepts event batches. */
  function experimentServer(variants: Record<string, string | null>, fail = 0) {
    const assignmentCalls: { url: string; body: Record<string, string> }[] = [];
    const batches: WireEvent[][] = [];
    let failures = fail;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.endsWith("/v1/experiments/assignments")) {
        assignmentCalls.push({ url, body });
        if (failures-- > 0) return new Response("{}", { status: 503 });
        const assignments = Object.entries(variants).map(([experiment, variant]) => ({ experiment, experiment_id: `id-${experiment}`, variant }));
        return new Response(JSON.stringify({ assignments }), { status: 200 });
      }
      batches.push(body.batch);
      return new Response(JSON.stringify({ accepted: body.batch.length, duplicates: 0, rejected: [] }), { status: 200 });
    });
    return { assignmentCalls, batches, fetch: fetchFn as unknown as typeof fetch };
  }

  it("returns the variant, sends the exposure once, and reuses the assignments", async () => {
    const s = experimentServer({ checkout_button: "treatment", onboarding: null });
    const { client } = make({ fetch: s.fetch, endpoint: "https://api.example.test" });
    client.identify("u-42");
    expect(await client.getVariant("checkout_button")).toBe("treatment");
    expect(await client.getVariant("checkout_button")).toBe("treatment");
    expect(await client.getVariant("onboarding")).toBeNull(); // not in it: no exposure
    expect(await client.getVariant("unknown")).toBeNull();
    expect(s.assignmentCalls).toHaveLength(1);
    expect(s.assignmentCalls[0].url).toBe("https://api.example.test/v1/experiments/assignments");
    expect(s.assignmentCalls[0].body).toEqual({ anonymous_id: client.getAnonymousId(), user_id: "u-42" });
    await client.flush();
    const exposures = s.batches.flat().filter((e) => e.event_name === "experiment_exposure");
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toMatchObject({ user_id: "u-42", properties: { experiment: "checkout_button", experiment_id: "id-checkout_button", variant: "treatment" } });
    expect(exposures[0].event_id).toMatch(/^exp:id-checkout_button:[0-9a-f]{8}$/);
  });

  it("asks again after the cache time or when the user changes", async () => {
    const s = experimentServer({ checkout_button: "control" });
    const { client, clock } = make({ fetch: s.fetch, experimentsCacheMs: 60_000 });
    await client.getVariant("checkout_button");
    clock.advance(61_000);
    await client.getVariant("checkout_button");
    expect(s.assignmentCalls).toHaveLength(2);
    client.identify("u-7");
    await client.getVariant("checkout_button");
    expect(s.assignmentCalls).toHaveLength(3);
    expect(s.assignmentCalls[2].body.user_id).toBe("u-7");
  });

  it("returns null when the request fails, then retries; expose: false sends nothing", async () => {
    const s = experimentServer({ checkout_button: "treatment" }, 1);
    const { client } = make({ fetch: s.fetch });
    expect(await client.getVariant("checkout_button")).toBeNull();
    expect(await client.getVariant("checkout_button", { expose: false })).toBe("treatment");
    expect(s.assignmentCalls).toHaveLength(2);
    await client.flush();
    expect(s.batches.flat().filter((e) => e.event_name === "experiment_exposure")).toHaveLength(0);
    client.trackExposure("checkout_button", "id-checkout_button", "treatment");
    client.trackExposure("checkout_button", "id-checkout_button", "treatment");
    await client.flush();
    expect(s.batches.flat().filter((e) => e.event_name === "experiment_exposure")).toHaveLength(1);
  });

  it("respects analytics consent for the exposure, and is on the singleton", async () => {
    const s = experimentServer({ checkout_button: "treatment" });
    const { client } = make({ fetch: s.fetch, consentDefault: "denied" });
    expect(await client.getVariant("checkout_button")).toBe("treatment");
    await client.flush();
    expect(s.batches.flat().filter((e) => e.event_name === "experiment_exposure")).toHaveLength(0);

    expect(await Analytics.getVariant("checkout_button")).toBeNull(); // not initialized
    Analytics.initialize({ apiKey: KEY, platform: "react_native", storage: memoryStorage(), fetch: s.fetch });
    expect(await Analytics.getVariant("checkout_button")).toBe("treatment");
  });
});
