import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "./schema";

// Size limits are checked before JSON parsing, rate limiting and storage; every
// dependency with I/O is mocked, so no database is needed.
const principal = { organizationId: "org", appId: "app", environmentId: "env", keyId: "key-1", kind: "sdk", scopes: ["events:write"] };
vi.mock("@/modules/credentials/service", () => ({ authenticateIngestionKey: async () => principal }));
vi.mock("@/lib/db", () => ({ withSystem: async () => {} }));
const consumeRateLimit = vi.fn(async (..._args: unknown[]) => 0);
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit }));
vi.mock("@/modules/processing/processor", () => ({ processPendingEvents: async () => ({ processed: 0, failed: 0 }) }));
vi.mock("next/server", () => ({ after: () => {} }));
const ingest = vi.fn(async (..._args: unknown[]) => ({ status: 200, body: { accepted: 1 }, headers: {}, replayed: false }));
vi.mock("./service", () => ({ ingest }));

afterEach(() => {
  vi.clearAllMocks();
});

/** A JSON body of exactly `bytes` UTF-8 bytes, padded with "é" (2 bytes, 1 UTF-16 unit) plus at most one "a". */
function body(bytes: number): string {
  const shell = JSON.stringify({ event: "x", properties: { pad: "" } });
  const room = bytes - Buffer.byteLength(shell, "utf8");
  const pad = "é".repeat(Math.floor(room / 2)) + (room % 2 ? "a" : "");
  const text = JSON.stringify({ event: "x", properties: { pad } });
  expect(Buffer.byteLength(text, "utf8")).toBe(bytes);
  return text;
}

const post = (path: string, text: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: "Bearer la_pk_test", "content-type": "application/json", ...headers }, body: text });

describe("handleIngest size limits (bytes, not characters)", () => {
  for (const [mode, path, max] of [
    ["batch", "/v1/events/batch", LIMITS.maxBatchBytes],
    ["single", "/v1/events", LIMITS.maxEventBytes],
  ] as const) {
    it(`${mode}: rejects a body under the limit in characters but over it in UTF-8 bytes with 413`, async () => {
      const { handleIngest } = await import("./http");
      const text = body(max + 2);
      expect(text.length).toBeLessThan(max);
      const res = await handleIngest(post(path, text), mode);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large", message: `Body exceeds ${max} bytes.` });
      expect(ingest).not.toHaveBeenCalled();
    });

    it(`${mode}: accepts a body exactly at the byte limit`, async () => {
      const { handleIngest } = await import("./http");
      const res = await handleIngest(post(path, body(max)), mode);
      expect(res.status).toBe(200);
      expect(ingest).toHaveBeenCalledTimes(1);
    });

    it(`${mode}: rejects early on a Content-Length over the limit`, async () => {
      const { handleIngest } = await import("./http");
      const res = await handleIngest(post(path, "{}", { "content-length": String(max + 1) }), mode);
      expect(res.status).toBe(413);
      expect((await res.json()).error).toBe("payload_too_large");
      expect(ingest).not.toHaveBeenCalled();
    });
  }

  it("batch: ~800K characters of 'é' (1.6 MB) is refused", async () => {
    const { handleIngest } = await import("./http");
    const text = JSON.stringify({ batch: [{ event: "x", properties: { pad: "é".repeat(800_000) } }] });
    expect(text.length).toBeLessThan(LIMITS.maxBatchBytes);
    const res = await handleIngest(post("/v1/events/batch", text), "batch");
    expect(res.status).toBe(413);
  });
});

describe("handleIngest rate limits", () => {
  const events = JSON.stringify({ batch: [{ type: "track", event_name: "a", anonymous_id: "x" }, { type: "track", event_name: "b", anonymous_id: "x" }] });

  it("counts every event against the environment, the API key and the client IP (hashed, never raw)", async () => {
    const { handleIngest } = await import("./http");
    const res = await handleIngest(post("/v1/events/batch", events, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), "batch");
    expect(res.status).toBe(200);
    const keys = consumeRateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toBe("ingest:env");
    expect(keys[1]).toBe("ingest:key:key-1");
    expect(keys[2]).toMatch(/^ingest:ip:env:[A-Za-z0-9_-]{32}$/);
    expect(keys[2]).not.toContain("203.0.113.9");
    for (const c of consumeRateLimit.mock.calls) expect(c[3]).toBe(2);
  });

  it("answers 429 with Retry-After from the first limit reached, and stores nothing", async () => {
    const { handleIngest } = await import("./http");
    consumeRateLimit.mockImplementation(async (...args: unknown[]) => (String(args[0]).startsWith("ingest:ip:") ? 12 : 0));
    const res = await handleIngest(post("/v1/events/batch", events, { "x-real-ip": "198.51.100.4" }), "batch");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(await res.json()).toEqual({ error: "rate_limited", message: "Event rate limit exceeded for this IP address." });
    expect(ingest).not.toHaveBeenCalled();
    consumeRateLimit.mockImplementation(async () => 0);
  });

  it("does not limit server keys by IP (one server sends for many users)", async () => {
    const { handleIngest } = await import("./http");
    principal.kind = "api";
    try {
      await handleIngest(post("/v1/events/batch", events, { "x-forwarded-for": "203.0.113.9" }), "batch");
      expect(consumeRateLimit.mock.calls.map((c) => String(c[0]))).toEqual(["ingest:env", "ingest:key:key-1"]);
    } finally {
      principal.kind = "sdk";
    }
  });
});
