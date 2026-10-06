import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext("/o/acme?tab=1#x")).toBe("/o/acme?tab=1#x");
    expect(safeNext("/")).toBe("/");
  });

  it("refuses anything that could leave the origin", () => {
    for (const v of [
      "//evil.example", "/\\evil.example", "\\\\evil.example", "/\t/evil.example", "/\n/evil.example", "/%0a",
      "https://evil.example", "javascript:alert(1)", "evil.example", "", " /x", null, undefined, 42, ["/x"],
    ]) {
      const r = safeNext(v);
      if (r !== null) expect(new URL(r, "https://app.example").origin).toBe("https://app.example");
    }
    expect(safeNext("//evil.example")).toBeNull();
    expect(safeNext("/\\evil.example")).toBeNull();
    expect(safeNext("/\t/evil.example")).toBeNull();
    expect(safeNext("https://evil.example")).toBeNull();
    expect(safeNext("javascript:alert(1)")).toBeNull();
    expect(safeNext(["/x"])).toBeNull();
  });
});
