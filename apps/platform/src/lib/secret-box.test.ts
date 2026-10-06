import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptionAvailable, encryptionKeyProblem, encryptSecret, SecretsUnavailableError } from "./secret-box";

describe("secret box", () => {
  const prev = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = prev;
  });

  it("round-trips, binds to the row, and fails safe without a key", () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "a".repeat(64);
    const c = encryptSecret("s3cret", "webhook:1");
    expect(c.startsWith("v1.")).toBe(true);
    expect(c).not.toContain("s3cret");
    expect(decryptSecret(c, "webhook:1")).toBe("s3cret");
    expect(() => decryptSecret(c, "webhook:2")).toThrow();
    expect(() => decryptSecret(c)).toThrow();
    expect(encryptSecret("s3cret", "webhook:1")).not.toBe(c); // random IV
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptSecret(c, "webhook:1")).toThrow();
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    expect(() => encryptSecret("s", "a")).toThrow(SecretsUnavailableError);
    expect(() => decryptSecret(c, "webhook:1")).toThrow(SecretsUnavailableError);
  });

  it("reads values stored without row binding (attribution credentials)", () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const c = encryptSecret('{"token":"t"}');
    expect(decryptSecret(c)).toBe('{"token":"t"}');
  });

  it("accepts only a 32-byte key as base64 or hex", () => {
    expect(encryptionAvailable({ INTEGRATIONS_ENCRYPTION_KEY: "a".repeat(64) })).toBe(true);
    expect(encryptionAvailable({ INTEGRATIONS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") })).toBe(true);
    expect(encryptionAvailable({ INTEGRATIONS_ENCRYPTION_KEY: "short" })).toBe(false);
    expect(encryptionKeyProblem({ INTEGRATIONS_ENCRYPTION_KEY: "k".repeat(40) })).toMatch(/32 bytes/);
    expect(encryptionKeyProblem({})).toBeNull();
  });
});
