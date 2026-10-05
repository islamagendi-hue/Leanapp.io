import { parseAttribution, type Attribution } from "./attribution.js";
import { localStorageAdapter, memoryStorage, type StorageAdapter } from "./storage.js";

export const SDK_NAME = "leanapp-js";
export const SDK_VERSION = "0.1.0";
export const DEFAULT_ENDPOINT = "https://api.leanapp.io";

export type Platform = "android" | "ios" | "react_native" | "flutter" | "web" | "backend";
export type Properties = Record<string, unknown>;

export interface AnalyticsOptions {
  /** Public SDK key (la_pk_…) for apps, or a secret key (la_sk_…) on servers only. */
  apiKey: string;
  endpoint?: string;
  platform?: Platform;
  appVersion?: string;
  appBuild?: string;
  /** Defaults to localStorage in browsers and memory elsewhere. Pass asyncStorageAdapter(AsyncStorage) in React Native. */
  storage?: StorageAdapter;
  /** Send when this many events are queued. Default 20. */
  flushAt?: number;
  /** Send at least this often while events are queued. Default 10s. */
  flushIntervalMs?: number;
  /** Events per request. Default 100, server maximum 500. */
  maxBatchSize?: number;
  /** Oldest events are dropped beyond this. Default 1000. */
  maxQueueSize?: number;
  /** Queued events older than this are dropped. Default 7 days (the server rejects events older than 31 days). */
  eventTtlMs?: number;
  /** Inactivity after which a new session starts. Default 30 minutes. */
  sessionTimeoutMs?: number;
  /** Extra context merged into every event (device, os_version, …). */
  context?: Record<string, unknown>;
  /** Stop sending (events still queue) until optIn(). */
  optedOut?: boolean;
  debug?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
}

export interface WireEvent {
  type: "track" | "screen" | "identify" | "alias" | "push_token";
  event_name?: string;
  event_id: string;
  timestamp: string;
  anonymous_id: string;
  user_id?: string;
  previous_id?: string;
  session_id?: string;
  properties?: Properties;
  user_properties?: Properties;
  context: Record<string, unknown>;
  push_token?: { token: string; provider: "fcm" | "apns"; permission?: string };
}

interface QueuedEvent {
  e: WireEvent;
  queuedAt: number;
}

interface PersistedState {
  anonymousId: string;
  userId?: string;
  sessionId?: string;
  lastActivity?: number;
  attribution?: { first: Attribution; latest: Attribution };
}

export type FlushResult =
  | { status: "empty" | "paused" | "busy" }
  | { status: "sent"; accepted: number; duplicates: number; rejected: number }
  | { status: "retry"; retryInMs: number; reason: string }
  | { status: "unauthorized" };

const KEY_PATTERN = /^la_(pk|sk)_(dev|stg|live)_[A-Za-z0-9_-]{20,}$/;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function defaultUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random: only for runtimes without crypto (old React Native).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function detectPlatform(): Platform {
  const g = globalThis as { navigator?: { product?: string }; document?: unknown; process?: { versions?: { node?: string } } };
  if (g.navigator?.product === "ReactNative") return "react_native";
  if (g.document) return "web";
  if (g.process?.versions?.node) return "backend";
  return "web";
}

function autoContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions();
    if (intl.timeZone) ctx.timezone = intl.timeZone;
    if (intl.locale) {
      ctx.locale = intl.locale;
      ctx.language = intl.locale.split("-")[0];
    }
  } catch {
    /* Intl unavailable */
  }
  const g = globalThis as { screen?: { width?: number; height?: number }; devicePixelRatio?: number };
  if (g.screen?.width) ctx.screen = { width: g.screen.width, height: g.screen.height, density: g.devicePixelRatio };
  return ctx;
}

/**
 * The LeanApp client. Every call is synchronous and never throws on the hot
 * path: events go to a persistent queue and are sent in batches with retries.
 */
export class LeanAppClient {
  private readonly o: Required<Omit<AnalyticsOptions, "appVersion" | "appBuild" | "platform" | "context" | "optedOut" | "storage">> & {
    platform: Platform;
    appVersion?: string;
    appBuild?: string;
    context: Record<string, unknown>;
  };
  private readonly storage: StorageAdapter;
  private readonly prefix: string;
  private state: PersistedState = { anonymousId: "" };
  private queue: QueuedEvent[] = [];
  private pending: (() => void)[] = [];
  private ready = false;
  private readonly readyPromise: Promise<void>;
  private sending = false;
  private paused = false;
  private optedOut: boolean;
  private failures = 0;
  private retryAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: AnalyticsOptions) {
    if (!options || typeof options.apiKey !== "string" || !KEY_PATTERN.test(options.apiKey)) {
      throw new Error("LeanApp: apiKey must be a LeanApp key (la_pk_… for apps). Find it under Developers → SDK & API keys.");
    }
    const platform = options.platform ?? detectPlatform();
    if (options.apiKey.startsWith("la_sk_") && platform !== "backend") {
      throw new Error("LeanApp: secret keys (la_sk_…) are for servers only. Use the public SDK key (la_pk_…) in apps.");
    }
    this.o = {
      apiKey: options.apiKey,
      endpoint: (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, ""),
      platform,
      appVersion: options.appVersion,
      appBuild: options.appBuild,
      flushAt: Math.max(1, options.flushAt ?? 20),
      flushIntervalMs: Math.max(1_000, options.flushIntervalMs ?? 10_000),
      maxBatchSize: Math.min(500, Math.max(1, options.maxBatchSize ?? 100)),
      maxQueueSize: Math.max(10, options.maxQueueSize ?? 1_000),
      eventTtlMs: options.eventTtlMs ?? 7 * 86_400_000,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 30 * 60_000,
      context: options.context ?? {},
      debug: options.debug ?? false,
      fetch: options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      now: options.now ?? Date.now,
      uuid: options.uuid ?? defaultUuid,
      random: options.random ?? Math.random,
    };
    this.optedOut = options.optedOut ?? false;
    this.storage = options.storage ?? (platform === "web" ? localStorageAdapter() : memoryStorage());
    // Keys are scoped per environment key prefix so dev and production data never share a queue.
    this.prefix = `leanapp:${options.apiKey.slice(0, 14)}:`;
    this.readyPromise = this.load();
  }

  /** Resolves once persisted identity and queue are loaded. Calls made earlier are buffered, not lost. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  track(eventName: string, properties: Properties = {}, options: { eventId?: string; timestamp?: Date } = {}): void {
    if (typeof eventName !== "string" || !eventName.trim()) return this.warn("track() needs an event name");
    this.enqueue(() => ({ type: "track", event_name: eventName.trim(), properties: { ...properties } }), options);
  }

  screen(screenName: string, properties: Properties = {}): void {
    if (!screenName) return this.warn("screen() needs a screen name");
    this.enqueue(() => ({ type: "screen", event_name: screenName, properties: { ...properties, screen_name: screenName } }));
  }

  /** Links this device to your user id. Traits are facts about the person (plan, city), not actions. */
  identify(userId?: string | null, traits: Properties = {}): void {
    this.enqueue(() => {
      if (userId) {
        this.state.userId = String(userId);
        this.persistState();
      }
      return { type: "identify", user_properties: { ...traits } };
    });
  }

  setUserProperties(traits: Properties): void {
    this.identify(undefined, traits);
  }

  /** Merges a previous user id into the current one (e.g. a guest account that signed up). */
  alias(newUserId: string, previousId?: string): void {
    this.enqueue(() => {
      const prev = previousId ?? this.state.userId ?? this.state.anonymousId;
      this.state.userId = newUserId;
      this.persistState();
      return { type: "alias", previous_id: prev };
    });
  }

  registerPushToken(token: string, provider: "fcm" | "apns", permission: "granted" | "denied" | "provisional" | "unknown" = "unknown"): void {
    this.enqueue(() => ({ type: "push_token", push_token: { token, provider, permission } }));
  }

  /**
   * Captures campaign parameters from a deep link or landing URL. The first
   * touch is kept; the latest touch is attached to every following event.
   */
  captureAttribution(url: string): Attribution | null {
    const parsed = parseAttribution(url);
    if (!parsed) return null;
    this.whenLoaded(() => {
      this.state.attribution = { first: this.state.attribution?.first ?? parsed, latest: parsed };
      this.persistState();
    });
    return parsed;
  }

  /** Attribution captured on this device: first and latest touch. Null before anything was captured. */
  getAttribution(): { first: Attribution; latest: Attribution } | null {
    return this.state.attribution ?? null;
  }

  getAnonymousId(): string {
    return this.state.anonymousId;
  }

  getUserId(): string | null {
    return this.state.userId ?? null;
  }

  /** Call on logout: forgets the user and starts a new anonymous identity and session. Queued events keep their ids. */
  reset(): void {
    this.whenLoaded(() => {
      this.state = { anonymousId: this.o.uuid() };
      this.persistState();
    });
  }

  optOut(): void {
    this.optedOut = true;
  }

  optIn(): void {
    this.optedOut = false;
    this.schedule(0);
  }

  /** Sends everything queued now, batch after batch, and resolves with the last result. */
  async flush(): Promise<FlushResult> {
    await this.readyPromise;
    let last: FlushResult = { status: "empty" };
    // Bounded: each round either removes events or stops.
    for (let i = 0; i < 1000; i++) {
      const r = await this.sendBatch(true);
      if (r.status === "sent") {
        last = r;
        if (this.queue.length) continue;
        return r;
      }
      return r.status === "empty" && last.status === "sent" ? last : r;
    }
    return last;
  }

  /** Stops timers. Pending events stay persisted and are sent by the next client. */
  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.persistChain;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private async load(): Promise<void> {
    try {
      const [rawState, rawQueue] = await Promise.all([this.storage.getItem(this.prefix + "state"), this.storage.getItem(this.prefix + "queue")]);
      const state = rawState ? (JSON.parse(rawState) as PersistedState) : null;
      this.state = state?.anonymousId ? state : { anonymousId: this.o.uuid() };
      const q = rawQueue ? (JSON.parse(rawQueue) as QueuedEvent[]) : [];
      this.queue = Array.isArray(q) ? q.filter((x) => x && x.e && typeof x.e.event_id === "string") : [];
    } catch (err) {
      this.warn("could not read persisted state; starting fresh", err);
      this.state = { anonymousId: this.o.uuid() };
      this.queue = [];
    }
    this.persistState();
    this.ready = true;
    const fns = this.pending;
    this.pending = [];
    for (const fn of fns) fn();
    this.persistQueue();
    if (this.queue.length) this.schedule(0);
  }

  private whenLoaded(fn: () => void) {
    if (this.ready) fn();
    else this.pending.push(fn);
  }

  private enqueue(build: () => Omit<WireEvent, "event_id" | "timestamp" | "anonymous_id" | "context">, options: { eventId?: string; timestamp?: Date } = {}) {
    // Timestamp is taken at call time, not when storage finishes loading.
    const at = options.timestamp?.getTime() ?? this.o.now();
    this.whenLoaded(() => {
      try {
        const partial = build();
        const e: WireEvent = {
          ...partial,
          event_id: options.eventId ?? this.o.uuid(),
          timestamp: new Date(at).toISOString(),
          anonymous_id: this.state.anonymousId,
          session_id: this.touchSession(at),
          context: this.context(),
        };
        if (this.state.userId) e.user_id = this.state.userId;
        if (this.queue.some((q) => q.e.event_id === e.event_id)) return; // duplicate call with the same event id
        this.queue.push({ e, queuedAt: this.o.now() });
        if (this.queue.length > this.o.maxQueueSize) {
          const dropped = this.queue.length - this.o.maxQueueSize;
          this.queue.splice(0, dropped);
          this.warn(`queue full: dropped ${dropped} oldest event(s)`);
        }
        this.log("queued", e.type, e.event_name ?? "");
        this.persistQueue();
        this.schedule(this.queue.length >= this.o.flushAt ? 0 : this.o.flushIntervalMs);
      } catch (err) {
        this.warn("failed to queue event", err);
      }
    });
  }

  private touchSession(at: number): string {
    const s = this.state;
    if (!s.sessionId || !s.lastActivity || at - s.lastActivity > this.o.sessionTimeoutMs) s.sessionId = this.o.uuid();
    s.lastActivity = Math.max(at, s.lastActivity ?? 0);
    this.persistState();
    return s.sessionId;
  }

  private context(): Record<string, unknown> {
    const ctx: Record<string, unknown> = { ...autoContext(), ...this.o.context, platform: this.o.platform, sdk: { name: SDK_NAME, version: SDK_VERSION } };
    if (this.o.appVersion) ctx.app_version = this.o.appVersion;
    if (this.o.appBuild) ctx.app_build = this.o.appBuild;
    if (this.state.attribution) ctx.attribution = { ...this.state.attribution.latest };
    return ctx;
  }

  private schedule(delayMs: number) {
    if (this.paused) return;
    const wait = Math.max(delayMs, this.retryAt - this.o.now(), 0);
    if (this.timer) {
      if (wait > 0) return; // a send is already scheduled
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendBatch(false).then((r) => {
        if (r.status === "sent" && this.queue.length) this.schedule(this.queue.length >= this.o.flushAt ? 0 : this.o.flushIntervalMs);
      });
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private async sendBatch(manual: boolean): Promise<FlushResult> {
    if (this.paused) return { status: "unauthorized" };
    if (this.optedOut) return { status: "paused" };
    if (this.sending) return { status: "busy" };
    const now = this.o.now();
    if (!manual && now < this.retryAt) {
      this.schedule(this.retryAt - now);
      return { status: "retry", retryInMs: this.retryAt - now, reason: "backoff" };
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => now - q.queuedAt <= this.o.eventTtlMs);
    if (this.queue.length !== before) {
      this.warn(`dropped ${before - this.queue.length} expired event(s)`);
      this.persistQueue();
    }
    if (!this.queue.length) return { status: "empty" };

    const batch = this.queue.slice(0, this.o.maxBatchSize);
    this.sending = true;
    try {
      const res = await this.o.fetch(`${this.o.endpoint}/v1/events/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.o.apiKey}`,
          // Same events → same key, so a retried request is answered from the server's idempotency store.
          "Idempotency-Key": `${batch[0].e.event_id}:${batch.length}`,
        },
        body: JSON.stringify({ batch: batch.map((q) => q.e), sent_at: new Date(this.o.now()).toISOString() }),
      });

      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { accepted?: number; duplicates?: number; rejected?: { index: number; errors: unknown }[] };
        for (const r of body.rejected ?? []) this.warn(`event rejected by server: ${batch[r.index]?.e.event_name ?? batch[r.index]?.e.type}`, r.errors);
        this.remove(batch);
        this.failures = 0;
        this.retryAt = 0;
        return { status: "sent", accepted: body.accepted ?? 0, duplicates: body.duplicates ?? 0, rejected: body.rejected?.length ?? 0 };
      }
      if (res.status === 401 || res.status === 403) {
        // Revoked or wrong key: keep events, stop sending until the app restarts with a valid key.
        this.paused = true;
        this.warn("API key rejected (revoked, expired or wrong environment). Events are kept but not sent.");
        return { status: "unauthorized" };
      }
      if (res.status === 413 && batch.length > 1) {
        this.o.maxBatchSize = Math.max(1, Math.floor(batch.length / 2));
        return this.backoff(0, "payload too large; splitting batch");
      }
      if (res.status === 400 || res.status === 413 || res.status === 422) {
        // The batch itself is malformed: retrying cannot succeed.
        this.warn(`server refused batch (${res.status}); dropping ${batch.length} event(s)`, await res.text().catch(() => ""));
        this.remove(batch);
        return { status: "sent", accepted: 0, duplicates: 0, rejected: batch.length };
      }
      const retryAfter = Number(res.headers.get("Retry-After"));
      return this.backoff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null, `HTTP ${res.status}`);
    } catch (err) {
      return this.backoff(null, err instanceof Error ? err.message : "network error");
    } finally {
      this.sending = false;
    }
  }

  private backoff(explicitMs: number | null, reason: string): FlushResult {
    this.failures++;
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.failures - 1, 16));
    const wait = explicitMs ?? Math.round(exp / 2 + this.o.random() * (exp / 2)); // jittered
    this.retryAt = this.o.now() + wait;
    this.log(`send failed (${reason}); retrying in ${wait}ms`);
    this.schedule(wait);
    return { status: "retry", retryInMs: wait, reason };
  }

  private remove(sent: QueuedEvent[]) {
    const ids = new Set(sent.map((q) => q.e.event_id));
    this.queue = this.queue.filter((q) => !ids.has(q.e.event_id));
    this.persistQueue();
  }

  private persistQueue() {
    const snapshot = JSON.stringify(this.queue);
    this.persist(() => this.storage.setItem(this.prefix + "queue", snapshot));
  }

  private persistState() {
    const snapshot = JSON.stringify(this.state);
    this.persist(() => this.storage.setItem(this.prefix + "state", snapshot));
  }

  // Writes are serialized so an older snapshot never overwrites a newer one.
  private persist(write: () => Promise<void>) {
    this.persistChain = this.persistChain.then(write).catch((err) => this.warn("storage write failed", err));
  }

  private log(...a: unknown[]) {
    if (this.o.debug) console.log("[LeanApp]", ...a);
  }

  private warn(msg: string, detail?: unknown) {
    if (this.o.debug) console.warn("[LeanApp]", msg, detail ?? "");
  }
}
