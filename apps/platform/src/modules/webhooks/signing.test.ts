import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { backoffSeconds, isPrivateAddress, MAX_ATTEMPTS, signatureHeader, verifySignature } from "./signing";

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = '{"id":"1","type":"webhook.test"}';

  it("signs t.body with HMAC-SHA256 and verifies within the tolerance", () => {
    const header = signatureHeader(secret, body, 1_700_000_000);
    const mac = createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex");
    expect(header).toBe(`t=1700000000,v1=${mac}`);
    expect(verifySignature(secret, header, body, { now: 1_700_000_100 })).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale timestamps and junk", () => {
    const header = signatureHeader(secret, body, 1_700_000_000);
    expect(verifySignature(secret, header, body + " ", { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature("whsec_other", header, body, { now: 1_700_000_000 })).toBe(false);
    expect(verifySignature(secret, header, body, { now: 1_700_000_000 + 301 })).toBe(false);
    expect(verifySignature(secret, "v1=abc", body)).toBe(false);
    expect(verifySignature(secret, null, body)).toBe(false);
  });
});

describe("retry schedule", () => {
  it("doubles from one minute, caps at six hours, adds bounded jitter", () => {
    const none = () => 0;
    expect([1, 2, 3, 4].map((a) => backoffSeconds(a, none))).toEqual([60, 120, 240, 480]);
    expect(backoffSeconds(20, none)).toBe(6 * 3600);
    expect(backoffSeconds(1, () => 0.999)).toBeLessThanOrEqual(66);
    const total = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffSeconds(i + 1, none)).reduce((a, b) => a + b, 0);
    expect(total / 3600).toBeGreaterThan(8);
    expect(total / 3600).toBeLessThan(10);
  });
});

describe("outbound address rules", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });
});
