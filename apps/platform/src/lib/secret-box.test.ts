import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, SecretsUnavailableError } from "./secret-box";

describe("secret box", () => {
  const prev = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = prev;
  });

  it("round-trips, binds to the row, and fails safe without a key", () => {
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "k".repeat(40);
    const c = encryptSecret("s3cret", "webhook:1");
    expect(c.startsWith("v1.")).toBe(true);
    expect(c).not.toContain("s3cret");
    expect(decryptSecret(c, "webhook:1")).toBe("s3cret");
    expect(() => decryptSecret(c, "webhook:2")).toThrow();
    expect(encryptSecret("s3cret", "webhook:1")).not.toBe(c); // random IV
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "x".repeat(40);
    expect(() => decryptSecret(c, "webhook:1")).toThrow();
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    expect(() => encryptSecret("s", "a")).toThrow(SecretsUnavailableError);
  });
});
