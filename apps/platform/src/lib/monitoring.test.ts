import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PER_WINDOW, THROTTLE_WINDOW_MS, admit, captureException, parseSentryDsn, report, reportServerErrorResponse, resetMonitoring, scrub, scrubRoute } from "./monitoring";

const WEBHOOK = "https://hooks.example.test/services/T000/B000/XXXX";

function mockFetch(status = 200) {
  const fn = vi.fn(async (..._args: unknown[]) => new Response("ok", { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentBodies(fn: ReturnType<typeof mockFetch>): string[] {
  return fn.mock.calls.map((c) => String((c[1] as RequestInit).body));
}

describe("scrub", () => {
  it("removes credentials, tokens and personal data", () => {
    const raw = [
      "connect failed postgres://postgres:hunter2@db.example.com:5432/platform",
      "Authorization: Bearer abc.def.ghi",
      "key la_sk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and la_pk_dev_BBBBBBBBBBBBBBBBBBBBBB",
      "stripe sk_live_51Habcdefg whsec_abc123 re_123456789012345678",
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig and {"password":"p@ss","token": "t0k"} secret=xyz',
      "user jane.doe@example.com from 203.0.113.7 phone +44 7700 900123",
      "fetch https://api.example.com/v1/x?access_token=zzz&email=a@b.co",
      "id 3f2a9c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b hash 0123456789abcdef0123456789abcdef01",
    ].join("\n");
    const out = scrub(raw, 2000);
    for (const leaked of [
      "hunter2",
      "abc.def.ghi",
      "AAAAAAAA",
      "BBBBBBBB",
      "51Habcdefg",
      "abc123",
      "123456789012345678",
      "eyJhbGci",
      "p@ss",
      "t0k",
      "xyz",
      "jane.doe",
      "203.0.113.7",
      "7700 900123",
      "access_token=zzz",
      "a@b.co",
      "3f2a9c4e",
      "0123456789abcdef",
    ]) {
      expect(out, leaked).not.toContain(leaked);
    }
    expect(out).toContain("db.example.com"); // the host stays: it is what makes the error actionable
    expect(out).toContain("https://api.example.com/v1/x?[redacted]");
    expect(out).not.toContain("\n");
  });

  it("keeps ordinary messages readable and caps length", () => {
    expect(scrub("Cannot read properties of undefined (reading 'id')")).toBe("Cannot read properties of undefined (reading 'id')");
    expect(scrub("x".repeat(20) + " " + "y ".repeat(400)).length).toBeLessThanOrEqual(300);
  });

  it("turns concrete paths into templates", () => {
    expect(scrubRoute("/v1/users/12345/events?email=a@b.co")).toBe("/v1/users/:id/events");
    expect(scrubRoute("/reset-password/AbCdEfGhIjKlMnOpQrStUvWxYz012345")).toBe("/reset-password/:id");
    expect(scrubRoute("/o/acme/apps/3f2a9c4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe("/o/acme/apps/:id");
  });
});

describe("throttle", () => {
  beforeEach(() => resetMonitoring());

  it("sends one report per key per window and counts the rest", () => {
    const t = 1_000_000;
    expect(admit("a", t)).toEqual({ send: true, suppressed: 0 });
    expect(admit("a", t + 1)).toEqual({ send: false, suppressed: 1 });
    expect(admit("a", t + 2)).toEqual({ send: false, suppressed: 2 });
    expect(admit("a", t + THROTTLE_WINDOW_MS + 1)).toEqual({ send: true, suppressed: 2 });
  });

  it("caps distinct keys per window so a burst can't spam", () => {
    const t = 5_000_000;
    let sent = 0;
    for (let i = 0; i < 50; i++) if (admit(`k${i}`, t + i).send) sent++;
    expect(sent).toBe(MAX_PER_WINDOW);
    // After the window, a dropped key goes out and says how many were dropped.
    expect(admit("k40", t + THROTTLE_WINDOW_MS + 100)).toEqual({ send: true, suppressed: 1 });
  });
});

describe("delivery", () => {
  beforeEach(() => {
    resetMonitoring();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does nothing over the network when no destination is configured", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("SENTRY_DSN", "");
    const fetch = mockFetch();
    await captureException(new Error("boom"), { source: "test" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts a compact, scrubbed Slack/Discord message with route, digest, environment and commit", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", WEBHOOK);
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef0123456789abcdef01234567");
    const fetch = mockFetch();
    const err = Object.assign(new TypeError("lookup failed for jane@example.com with Bearer secret-token-value"), { digest: "1234567890" });
    await captureException(err, { source: "request:route", route: "GET /v1/users/98765" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(WEBHOOK);
    const body = JSON.parse(sentBodies(fetch)[0]);
    expect(body.text).toBe(body.content);
    expect(body.text).toContain("[LeanApp production] ERROR: Exception in GET /v1/users/:id");
    expect(body.text).toContain("TypeError: lookup failed for [email] with Bearer [redacted]");
    expect(body.text).toContain("digest: 1234567890");
    expect(body.text).toContain("commit: 0123456789ab");
    expect(body.text).not.toContain("jane@example.com");
    expect(body.text).not.toContain("secret-token-value");
    expect(body.text).not.toContain("98765");
  });

  it("dedupes a burst of the same error into one alert", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", WEBHOOK);
    const fetch = mockFetch();
    for (let i = 0; i < 20; i++) await reportServerErrorResponse("POST /v1/events", 500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports an error object once even when it is captured twice (step + onRequestError)", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", WEBHOOK);
    const fetch = mockFetch();
    const err = new Error("step broke");
    await captureException(err, { source: "worker:processing" });
    await captureException(err, { source: "request:route", route: "GET /api/internal/process-events" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores client errors and framework control flow", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", WEBHOOK);
    const fetch = mockFetch();
    await captureException(Object.assign(new Error("nope"), { status: 404 }), { source: "test" });
    await captureException(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" }), { source: "test" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never throws when delivery fails, and never logs the destination URL", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", WEBHOOK);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network down"))));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(report({ key: "k", severity: "warning", title: "t", source: "s" })).resolves.toBeUndefined();
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("monitoring.delivery_failed");
    expect(logged).not.toContain("hooks.example.test");
  });

  it("sends a Sentry envelope over plain HTTP when SENTRY_DSN is set", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "");
    vi.stubEnv("SENTRY_DSN", "https://publickey123@o1.ingest.sentry.example/42");
    const fetch = mockFetch();
    await captureException(new RangeError("bad range"), { source: "worker:processing", route: "GET /api/internal/process-events" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.sentry.example/api/42/envelope/");
    expect((init.headers as Record<string, string>)["X-Sentry-Auth"]).toContain("sentry_key=publickey123");
    const [header, item, event] = String(init.body).trim().split("\n").map((l) => JSON.parse(l));
    expect(header.event_id).toBe(event.event_id);
    expect(item).toEqual({ type: "event" });
    expect(event.exception.values[0]).toEqual({ type: "RangeError", value: "bad range" });
    expect(event.tags).toMatchObject({ source: "worker:processing", route: "GET /api/internal/process-events" });
  });

  it("parses DSNs strictly", () => {
    expect(parseSentryDsn("https://k@sentry.example/prefix/7")?.endpoint).toBe("https://sentry.example/prefix/api/7/envelope/");
    expect(parseSentryDsn("http://k@sentry.example/7")).toBeNull();
    expect(parseSentryDsn("https://sentry.example/7")).toBeNull();
    expect(parseSentryDsn("not a url")).toBeNull();
    expect(parseSentryDsn(undefined)).toBeNull();
  });
});
