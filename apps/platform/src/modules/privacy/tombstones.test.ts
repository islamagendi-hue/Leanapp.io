import { describe, expect, it } from "vitest";
import { tombstoneHash } from "./tombstones";

const ENV = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

describe("tombstoneHash", () => {
  it("is a stable sha256 that doesn't contain the id", () => {
    const h = tombstoneHash(ENV, "user_id", "jane@example.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tombstoneHash(ENV, "user_id", "jane@example.com")).toBe(h);
    expect(h).not.toContain("jane");
  });

  it("differs per environment and per kind of id", () => {
    const h = tombstoneHash(ENV, "user_id", "u1");
    expect(tombstoneHash(OTHER, "user_id", "u1")).not.toBe(h);
    expect(tombstoneHash(ENV, "anonymous_id", "u1")).not.toBe(h);
    expect(tombstoneHash(ENV, "user_id", "u2")).not.toBe(h);
  });
});
