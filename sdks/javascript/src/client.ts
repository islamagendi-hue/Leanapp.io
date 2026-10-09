import { parseAttribution, type Attribution } from "./attribution.js";
import { localStorageAdapter, memoryStorage, type StorageAdapter } from "./storage.js";

export const SDK_NAME = "leanapp-js";
export const SDK_VERSION = "0.1.0";
export const DEFAULT_ENDPOINT = "https://api.leanapp.io";

export type Platform = "android" | "ios" | "react_native" | "flutter" | "web" | "backend";
export type Properties = Record<string, unknown>;

/** What the user can agree to. Each purpose is decided separately. */
export const CONSENT_PURPOSES = ["analytics", "marketing", "push", "attribution"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentStatus = "granted" | "pending" | "denied";
/** The user's answers; purposes left out keep their current state. */
export type ConsentInput = Partial<Record<ConsentPurpose, boolean>>;
export type ConsentState = Record<ConsentPurpose, ConsentStatus>;

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
  /**
   * Consent assumed until setConsent() records the user's answer, for every purpose or per purpose.
   * "granted" (default, the behaviour before consent existed): track normally.
   * "pending": analytics events wait in memory only (not stored on the device, not sent) until consent
   * is granted, and are discarded if it is denied or the app closes first.
   * "denied": events are dropped.
   * Analytics consent governs track/screen/identify/alias; push consent governs registerPushToken;
   * attribution consent governs captureAttribution and the attribution attached to events.
   */
  consentDefault?: ConsentStatus | Partial<Record<ConsentPurpose, ConsentStatus>>;
  /**
   * Browsers: send queued events when the page is hidden or closed (visibilitychange → hidden, pagehide),
   * using fetch keepalive so the request outlives the page. Default true; ignored outside browsers.
   */
  flushOnHide?: boolean;
  /**
   * React Native: pass `AppState` from react-native (or anything with the same shape) to send queued
   * events when the app goes to the background. The SDK never imports react-native itself.
   */
  appState?: AppStateLike;
  /** How long getVariant() reuses the assignments it fetched for the same user. Default 5 minutes. */
  experimentsCacheMs?: number;
  debug?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  random?: () => number;
}

/** The subset of React Native's AppState the SDK uses. */
export interface AppStateLike {
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void } | void;
}

export interface WireEvent {
  type: "track" | "screen" | "identify" | "alias" | "push_token" | "consent";
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
  consent?: ConsentInput;
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
  /** The user's explicit answers (setConsent). Purposes not here follow consentDefault. */
  consent?: ConsentInput;
}

export type FlushResult =
  | { status: "empty" | "paused" | "busy" }
  | { status: "sent"; accepted: number; duplicates: number; rejected: number }
  | { status: "retry"; retryInMs: number; reason: string }
  | { status: "unauthorized" };

/** One running experiment's answer for a user, from /v1/experiments/assignments. */
export interface ExperimentAssignment {
  experiment: string;
  experiment_id: string;
  /** Null when the user isn't in the experiment: show your default. */
  variant: string | null;
}

/** The event that records a user saw a variant; experiment results count people from it. */
export const EXPOSURE_EVENT = "experiment_exposure";

const KEY_PATTERN = /^la_(pk|sk)_(dev|stg|live)_[A-Za-z0-9_-]{20,}$/;
// Browsers cap the bodies of all in-flight keepalive requests at 64 KiB; stay under it with headroom.
const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Storage namespace for a key: its kind and environment tag (la_pk_live), never the random part,
 * so rotating a key keeps each install's anonymous id and queue while dev and production stay apart.
 */
export function storagePrefix(apiKey: string): string {
  const [, kind, env] = KEY_PATTERN.exec(apiKey) ?? [];
  return `leanapp:la_${kind}_${env}:`;
}

/** Prefix used up to 0.1.0, which included random key characters. Read once to migrate. */
function legacyStoragePrefix(apiKey: string): string {
  return `leanapp:${apiKey.slice(0, 14)}:`;
}
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function byteLength(s: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length * 3;
}

/**
 * FNV-1a (32-bit) of the UTF-8 bytes of the event ids joined by "\n", as 8 hex
 * digits. Every SDK computes the same value for the same ids.
 */
export function eventIdsHash(ids: string[]): string {
  let h = 0x811c9dc5;
  const add = (b: number) => {
    h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (const ch of ids.join("\n")) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) {
      add(c);
    } else if (c < 0x800) {
      add(0xc0 | (c >> 6));
      add(0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      add(0xe0 | (c >> 12));
      add(0x80 | ((c >> 6) & 0x3f));
      add(0x80 | (c & 0x3f));
    } else {
      add(0xf0 | (c >> 18));
      add(0x80 | ((c >> 12) & 0x3f));
      add(0x80 | ((c >> 6) & 0x3f));
      add(0x80 | (c & 0x3f));
    }
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `<batch size>:<hash of every event id>:<first event id>`. The same events give the
 * same key on every retry; a batch whose events changed (one removed or added
 * between a lost response and the retry) gets a different key, so the server never
 * answers it with the response of a batch it did not send. The first id goes last
 * so the server's 200-character limit can only truncate it, never the hash.
 */
export function idempotencyKey(ids: string[]): string {
  return `${ids.length}:${eventIdsHash(ids)}:${ids[0] ?? ""}`;
}

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
  private readonly o: Required<Omit<AnalyticsOptions, "appVersion" | "appBuild" | "platform" | "context" | "optedOut" | "storage" | "flushOnHide" | "appState" | "consentDefault">> & {
    platform: Platform;
    appVersion?: string;
    appBuild?: string;
    context: Record<string, unknown>;
  };
  private readonly storage: StorageAdapter;
  private readonly prefix: string;
  private readonly legacyPrefix: string;
  private readonly unsubscribers: (() => void)[] = [];
  private state: PersistedState = { anonymousId: "" };
  private queue: QueuedEvent[] = [];
  /** Events waiting for consent: memory only, never persisted or sent until consent is granted. */
  private held: QueuedEvent[] = [];
  private readonly consentDefault: ConsentState;
  /** Attribution captured while attribution consent is pending: memory only. */
  private heldAttribution: { first: Attribution; latest: Attribution } | null = null;
  /** setConsent() answers given before storage loaded, for getConsent() only. */
  private earlyConsent: ConsentInput | null = null;
  private pending: (() => void)[] = [];
  private ready = false;
  private readonly readyPromise: Promise<void>;
  private sending = false;
  private paused = false;
  private optedOut: boolean;
  private failures = 0;
  private retryAt = 0;
  /** Set after a 409 idempotency_key_reused: the next request goes without a key (event ids still de-duplicate). */
  private skipIdempotencyKey = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  /** Assignments fetched for one user (user id + anonymous id), reused for experimentsCacheMs. */
  private assignments: { identity: string; at: number; promise: Promise<Map<string, ExperimentAssignment>> } | null = null;
  /** Exposures already queued by this client: experiment id, variant and user. */
  private readonly exposed = new Set<string>();

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
      experimentsCacheMs: Math.max(0, options.experimentsCacheMs ?? 5 * 60_000),
      debug: options.debug ?? false,
      fetch: options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      now: options.now ?? Date.now,
      uuid: options.uuid ?? defaultUuid,
      random: options.random ?? Math.random,
    };
    this.optedOut = options.optedOut ?? false;
    const d = options.consentDefault ?? "granted";
    this.consentDefault = Object.fromEntries(
      CONSENT_PURPOSES.map((p) => [p, typeof d === "string" ? d : (d[p] ?? "granted")]),
    ) as ConsentState;
    this.storage = options.storage ?? (platform === "web" ? localStorageAdapter() : memoryStorage());
    // Scoped per key kind and environment so dev and production data never share a queue.
    this.prefix = storagePrefix(options.apiKey);
    this.legacyPrefix = legacyStoragePrefix(options.apiKey);
    this.readyPromise = this.load();
    this.watchLifecycle(options);
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
    let changed = false;
    this.enqueue(() => {
      if (userId) {
        changed = this.state.userId !== String(userId);
        this.state.userId = String(userId);
        this.persistState();
      }
      return { type: "identify", user_properties: { ...traits } };
    });
    // Consent given on this device follows the user who signs in on it.
    this.whenLoaded(() => {
      if (changed) this.resendConsent();
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
    this.whenLoaded(() => this.resendConsent());
  }

  registerPushToken(token: string, provider: "fcm" | "apns", permission: "granted" | "denied" | "provisional" | "unknown" = "unknown"): void {
    this.enqueue(() => ({ type: "push_token", push_token: { token, provider, permission } }), {}, "push");
  }

  /**
   * Captures campaign parameters from a deep link or landing URL. The first
   * touch is kept; the latest touch is attached to every following event.
   */
  captureAttribution(url: string): Attribution | null {
    const parsed = parseAttribution(url);
    if (!parsed) return null;
    this.whenLoaded(() => {
      const status = this.consentFor("attribution");
      if (status === "denied") return;
      if (status === "pending") {
        // Kept in memory until the user decides; stored only once attribution consent is granted.
        this.heldAttribution = { first: this.heldAttribution?.first ?? this.state.attribution?.first ?? parsed, latest: parsed };
        return;
      }
      this.state.attribution = { first: this.state.attribution?.first ?? parsed, latest: parsed };
      this.persistState();
    });
    return parsed;
  }

  /**
   * Records the user's consent answers, e.g. from your consent screen. Purposes left out keep their state.
   * The answers are stored on the device and sent to LeanApp (always, whatever they are, so the
   * platform can honour them). Granting analytics releases events waiting in memory; denying it
   * discards them and clears the unsent queue.
   */
  setConsent(consent: ConsentInput): void {
    const changes: ConsentInput = {};
    for (const p of CONSENT_PURPOSES) if (typeof consent?.[p] === "boolean") changes[p] = consent[p];
    if (!Object.keys(changes).length) return this.warn("setConsent() needs at least one of analytics, marketing, push, attribution as a boolean");
    const at = this.o.now();
    if (!this.ready) this.earlyConsent = { ...this.earlyConsent, ...changes };
    this.whenLoaded(() => {
      this.state.consent = { ...this.state.consent, ...changes };
      this.persistState();
      // The change goes first, then whatever it releases.
      this.pushConsent(changes, at);
      this.applyConsent();
    });
  }

  /** Current consent per purpose: the user's answer, or consentDefault where they haven't answered. */
  getConsent(): ConsentState {
    return Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, this.consentFor(p)])) as ConsentState;
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

  /**
   * The variant of a running experiment for the current user, or null when they aren't in it
   * (outside its traffic or audience, stopped, unknown key) or the request fails: then show your
   * default. The first time a variant is returned for this user, an `experiment_exposure` event is
   * queued (once; pass `{ expose: false }` and call trackExposure() where the variant is shown).
   * Assignments are fetched together from POST /v1/experiments/assignments and reused for
   * `experimentsCacheMs`. Call it after identify() for experiments on signed-in users, since the
   * variant follows the user id.
   */
  async getVariant(experimentKey: string, options: { expose?: boolean } = {}): Promise<string | null> {
    try {
      await this.readyPromise;
      const identity = `${this.state.userId ?? ""}\n${this.state.anonymousId}`;
      const now = this.o.now();
      if (!this.assignments || this.assignments.identity !== identity || now - this.assignments.at > this.o.experimentsCacheMs) {
        this.assignments = { identity, at: now, promise: this.fetchAssignments() };
      }
      const current = this.assignments;
      const map = await current.promise.catch((err: unknown) => {
        if (this.assignments === current) this.assignments = null; // ask again on the next call
        throw err;
      });
      const a = map.get(experimentKey);
      if (!a?.variant) return null;
      if (options.expose !== false) this.trackExposure(experimentKey, a.experiment_id, a.variant);
      return a.variant;
    } catch (err) {
      this.warn("getVariant failed; show the default", err);
      return null;
    }
  }

  /** Queues the `experiment_exposure` event for a variant you showed (getVariant does this unless `expose: false`). Once per user. */
  trackExposure(experimentKey: string, experimentId: string, variant: string): void {
    this.whenLoaded(() => {
      const user = this.state.userId ?? "";
      const seen = `${experimentId}\n${variant}\n${user}\n${this.state.anonymousId}`;
      if (this.exposed.has(seen)) return;
      this.exposed.add(seen);
      // A stable id, so a repeat after a restart is de-duplicated by the server.
      const eventId = `exp:${experimentId}:${eventIdsHash([variant, user, this.state.anonymousId])}`;
      this.track(EXPOSURE_EVENT, { experiment: experimentKey, experiment_id: experimentId, variant }, { eventId });
    });
  }

  /**
   * Call on logout: forgets the user and starts a new anonymous identity and session. Queued events keep their ids.
   * Consent belongs to the device and is kept (and recorded for the new anonymous id).
   */
  reset(): void {
    this.whenLoaded(() => {
      this.state = { anonymousId: this.o.uuid(), ...(this.state.consent ? { consent: this.state.consent } : {}) };
      this.persistState();
      this.resendConsent();
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
    for (const off of this.unsubscribers.splice(0)) off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.persistChain;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private async load(): Promise<void> {
    let migrated = false;
    try {
      let [rawState, rawQueue] = await Promise.all([this.storage.getItem(this.prefix + "state"), this.storage.getItem(this.prefix + "queue")]);
      if (!rawState) {
        // One-time move from the 0.1.0 key-specific namespace.
        const [oldState, oldQueue] = await Promise.all([this.storage.getItem(this.legacyPrefix + "state"), this.storage.getItem(this.legacyPrefix + "queue")]);
        if (oldState || oldQueue) {
          rawState = oldState;
          rawQueue = oldQueue ?? rawQueue;
          migrated = true;
        }
      }
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
    this.earlyConsent = null;
    // Unsent events from before a denial (e.g. the app closed mid-way) are not sent.
    const kept = this.queue.filter((q) => q.e.type === "consent" || this.consentFor(q.e.type === "push_token" ? "push" : "analytics") !== "denied");
    if (kept.length !== this.queue.length) this.queue = kept;
    const fns = this.pending;
    this.pending = [];
    for (const fn of fns) fn();
    this.persistQueue();
    if (migrated) {
      // Queued after the new keys are written, so a crash in between leaves the data readable.
      this.persist(async () => {
        await this.storage.removeItem(this.legacyPrefix + "state");
        await this.storage.removeItem(this.legacyPrefix + "queue");
      });
    }
    if (this.queue.length) this.schedule(0);
  }

  private watchLifecycle(options: AnalyticsOptions) {
    if (options.appState) {
      const sub = options.appState.addEventListener("change", (state) => {
        if (state === "background") void this.flush();
      });
      if (sub) this.unsubscribers.push(() => sub.remove());
    }
    const g = globalThis as {
      document?: { visibilityState?: string; addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void };
      addEventListener?: (t: string, l: () => void) => void;
      removeEventListener?: (t: string, l: () => void) => void;
    };
    if (this.o.platform !== "web" || options.flushOnHide === false || !g.document?.addEventListener || !g.addEventListener) return;
    const onVisibility = () => {
      if (g.document?.visibilityState === "hidden") this.flushOnExit();
    };
    const onPageHide = () => this.flushOnExit();
    g.document.addEventListener("visibilitychange", onVisibility);
    g.addEventListener("pagehide", onPageHide);
    this.unsubscribers.push(() => {
      g.document?.removeEventListener?.("visibilitychange", onVisibility);
      g.removeEventListener?.("pagehide", onPageHide);
    });
  }

  /**
   * The page may be about to close: send one keepalive request that fits the browser's 64 KiB
   * budget. Whatever is not confirmed stays queued (persisted) and is sent on the next visit;
   * the idempotency key and event ids make a repeat harmless. sendBeacon is not used because it
   * cannot carry the Authorization header the ingestion API requires.
   */
  private flushOnExit() {
    if (!this.ready || this.paused || this.optedOut || this.sending || !this.queue.length) return;
    void this.sendBatch(true, true);
  }

  private whenLoaded(fn: () => void) {
    if (this.ready) fn();
    else this.pending.push(fn);
  }

  private enqueue(
    build: () => Omit<WireEvent, "event_id" | "timestamp" | "anonymous_id" | "context">,
    options: { eventId?: string; timestamp?: Date } = {},
    purpose: ConsentPurpose = "analytics",
  ) {
    // Timestamp is taken at call time, not when storage finishes loading.
    const at = options.timestamp?.getTime() ?? this.o.now();
    this.whenLoaded(() => {
      try {
        const partial = build();
        const status = this.consentFor(purpose);
        if (status === "denied") return this.log("dropped (consent denied):", partial.type, partial.event_name ?? "");
        const e: WireEvent = {
          ...partial,
          event_id: options.eventId ?? this.o.uuid(),
          timestamp: new Date(at).toISOString(),
          anonymous_id: this.state.anonymousId,
          session_id: this.touchSession(at),
          context: this.context(),
        };
        if (this.state.userId) e.user_id = this.state.userId;
        if (this.queue.some((q) => q.e.event_id === e.event_id) || this.held.some((q) => q.e.event_id === e.event_id)) return; // duplicate call with the same event id
        if (status === "pending") {
          // Waiting for consent: memory only, bounded like the queue.
          this.held.push({ e, queuedAt: this.o.now() });
          if (this.held.length > this.o.maxQueueSize) this.held.splice(0, this.held.length - this.o.maxQueueSize);
          this.log("held until consent:", e.type, e.event_name ?? "");
          return;
        }
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

  private async fetchAssignments(): Promise<Map<string, ExperimentAssignment>> {
    const body: Record<string, string> = { anonymous_id: this.state.anonymousId };
    if (this.state.userId) body.user_id = this.state.userId;
    const res = await this.o.fetch(`${this.o.endpoint}/v1/experiments/assignments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.o.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`assignments request failed with ${res.status}`);
    const json = (await res.json()) as { assignments?: ExperimentAssignment[] };
    return new Map((json.assignments ?? []).map((a) => [a.experiment, a]));
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
    if (this.state.attribution && this.consentFor("attribution") === "granted") ctx.attribution = { ...this.state.attribution.latest };
    return ctx;
  }

  private consentFor(purpose: ConsentPurpose): ConsentStatus {
    // Before storage has loaded, answer with the latest setConsent() call so getConsent() is current.
    const v = (!this.ready ? this.earlyConsent?.[purpose] : undefined) ?? this.state.consent?.[purpose];
    return v === true ? "granted" : v === false ? "denied" : this.consentDefault[purpose];
  }

  /** Moves or discards what was waiting for consent after the user's answer changed. */
  private applyConsent() {
    const analytics = this.consentFor("analytics");
    const push = this.consentFor("push");
    const waiting = (q: QueuedEvent) => (q.e.type === "push_token" ? push : analytics);
    const release = this.held.filter((q) => waiting(q) === "granted");
    this.held = this.held.filter((q) => waiting(q) === "pending");
    const before = this.queue.length;
    // Denied: unsent events of that purpose are discarded. Consent changes always stay.
    this.queue = this.queue.filter((q) => q.e.type === "consent" || waiting(q) !== "denied");
    if (before !== this.queue.length) this.log(`consent denied: discarded ${before - this.queue.length} unsent event(s)`);
    if (release.length) {
      this.queue.push(...release);
      if (this.queue.length > this.o.maxQueueSize) this.queue.splice(0, this.queue.length - this.o.maxQueueSize);
    }
    const attribution = this.consentFor("attribution");
    if (attribution === "granted" && this.heldAttribution) {
      this.state.attribution = { first: this.state.attribution?.first ?? this.heldAttribution.first, latest: this.heldAttribution.latest };
      this.persistState();
    }
    if (attribution !== "pending") this.heldAttribution = null;
    if (attribution === "denied" && this.state.attribution) {
      delete this.state.attribution;
      this.persistState();
    }
    if (before !== this.queue.length || release.length) this.persistQueue();
    if (this.queue.length) this.schedule(this.queue.length >= this.o.flushAt ? 0 : this.o.flushIntervalMs);
  }

  /**
   * Queues a consent change for LeanApp. Sent whatever the answer (it is the record of the answer)
   * with only the ids and minimal context: no session, properties or attribution.
   */
  private pushConsent(consent: ConsentInput, at: number) {
    const e: WireEvent = {
      type: "consent",
      consent: { ...consent },
      event_id: this.o.uuid(),
      timestamp: new Date(at).toISOString(),
      anonymous_id: this.state.anonymousId,
      context: { platform: this.o.platform, sdk: { name: SDK_NAME, version: SDK_VERSION }, ...(this.o.appVersion ? { app_version: this.o.appVersion } : {}) },
    };
    if (this.state.userId) e.user_id = this.state.userId;
    this.queue.push({ e, queuedAt: at });
    if (this.queue.length > this.o.maxQueueSize) {
      // Never drop a consent change to make room: drop the oldest other event instead.
      const i = this.queue.findIndex((q) => q.e.type !== "consent");
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
    this.log("queued consent", consent);
    this.persistQueue();
    this.schedule(0);
  }

  /** Records the device's explicit answers again for a new identity (sign-in, alias, reset). */
  private resendConsent() {
    if (this.state.consent && Object.keys(this.state.consent).length) this.pushConsent({ ...this.state.consent }, this.o.now());
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

  private async sendBatch(manual: boolean, keepalive = false): Promise<FlushResult> {
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

    let batch = this.queue.slice(0, this.o.maxBatchSize);
    let requestBody = this.payload(batch);
    if (keepalive) {
      while (batch.length > 1 && byteLength(requestBody) > KEEPALIVE_MAX_BYTES) {
        batch = batch.slice(0, Math.max(1, Math.floor(batch.length / 2)));
        requestBody = this.payload(batch);
      }
      if (byteLength(requestBody) > KEEPALIVE_MAX_BYTES) return { status: "retry", retryInMs: 0, reason: "event too large for keepalive" };
    }
    this.sending = true;
    const withKey = !this.skipIdempotencyKey;
    this.skipIdempotencyKey = false;
    try {
      const res = await this.o.fetch(`${this.o.endpoint}/v1/events/batch`, {
        method: "POST",
        ...(keepalive ? { keepalive: true } : {}),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.o.apiKey}`,
          // Same events → same key, so a retried request is answered from the server's idempotency store.
          ...(withKey ? { "Idempotency-Key": idempotencyKey(batch.map((q) => q.e.event_id)) } : {}),
        },
        body: requestBody,
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
      if (res.status === 409) {
        // idempotency_key_reused: nothing was stored. Keep the events and resend them without
        // a key; their event ids still make the resend safe.
        this.skipIdempotencyKey = true;
        return this.backoff(0, "idempotency key already used for other events; resending without it");
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

  private payload(batch: QueuedEvent[]): string {
    return JSON.stringify({ batch: batch.map((q) => q.e), sent_at: new Date(this.o.now()).toISOString() });
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
