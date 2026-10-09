import { describe, expect, it } from "vitest";
import { canonicalRequest, sha256Hex, signingKey, signRequest, uriEncode } from "./sigv4";

// Published AWS examples (no real credentials: these are AWS's documentation keys).
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sigv4", () => {
  it("derives the documented signing key", () => {
    expect(signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam").toString("hex"))
      .toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  it("matches the S3 GET Object example signature", () => {
    const headers = signRequest(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
      { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: EMPTY, now: new Date("2013-05-24T00:00:00Z") },
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers).not.toHaveProperty("host");
  });

  it("builds a canonical request with sorted, encoded query and headers", () => {
    const { request, signedHeaders } = canonicalRequest({
      method: "put",
      url: new URL("https://h.example/bucket/a%20b/c.png?z=1&a=x y"),
      headers: { "X-Amz-Date": "20260101T000000Z", Host: "h.example" },
      payloadHash: sha256Hex("hi"),
      now: new Date(),
    });
    expect(signedHeaders).toBe("host;x-amz-date");
    expect(request.split("\n").slice(0, 3)).toEqual(["PUT", "/bucket/a%20b/c.png", "a=x%20y&z=1"]);
  });

  it("encodes like RFC 3986", () => {
    expect(uriEncode("a b/ç~", true)).toBe("a%20b/%C3%A7~");
    expect(uriEncode("a/b", false)).toBe("a%2Fb");
  });
});
