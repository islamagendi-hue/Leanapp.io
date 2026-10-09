import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "./schema";

// Size limits are checked before JSON parsing, rate limiting and storage; every
// dependency with I/O is mocked, so no database is needed.
const principal = { organizationId: "org", environmentId: "env", kind: "ingestion", scopes: ["events:write"] };
vi.mock("@/modules/credentials/service", () => ({ authenticateIngestionKey: async () => principal }));
vi.mock("@/lib/db", () => ({ withSystem: async () => {} }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: async () => 0 }));
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
