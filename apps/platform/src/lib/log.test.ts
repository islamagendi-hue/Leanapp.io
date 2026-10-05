import { afterEach, describe, expect, it, vi } from "vitest";
import { write } from "./log";

describe("structured log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one JSON line with level, event, request id and flattened errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    write("error", "api.failed", { error: Object.assign(new Error("boom"), { code: "57P01" }), route: "/v1/x" }, "req-12345678");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ level: "error", event: "api.failed", request_id: "req-12345678", route: "/v1/x", error: { name: "Error", message: "boom", code: "57P01" } });
    expect(typeof entry.time).toBe("string");
  });
});
