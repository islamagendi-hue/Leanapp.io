import { describe, expect, it, vi } from "vitest";
import { mediaStorageConfig, mediaStorageProblems } from "./config";
import { s3Driver, s3ObjectUrl } from "./s3";

// Simulated: fetch is mocked. Nothing here talks to a real bucket.
const cfg = { endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", bucket: "media", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret", forcePathStyle: true };

describe("S3-compatible driver", () => {
  it("builds path-style and virtual-hosted object URLs", () => {
    expect(s3ObjectUrl(cfg, "org/1/app/2/a b.png").toString()).toBe("https://acct.r2.cloudflarestorage.com/media/org/1/app/2/a%20b.png");
    expect(s3ObjectUrl({ ...cfg, endpoint: "https://ref.supabase.co/storage/v1/s3" }, "k.png").toString()).toBe("https://ref.supabase.co/storage/v1/s3/media/k.png");
    expect(s3ObjectUrl({ ...cfg, endpoint: "https://s3.eu-west-1.amazonaws.com", forcePathStyle: false }, "k.png").toString()).toBe("https://media.s3.eu-west-1.amazonaws.com/k.png");
  });

  it("signs PUT, GET and DELETE and maps responses", async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "GET") return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 200 });
    });
    const d = s3Driver(cfg, fetchMock as unknown as typeof fetch, () => new Date("2026-10-01T00:00:00Z"));
    await d.put("k.png", new Uint8Array([1, 2, 3]), "image/png", "org");
    const [, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(init!.method).toBe("PUT");
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261001\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(headers["x-amz-content-sha256"]).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    expect(JSON.stringify(headers)).not.toContain("test-secret");
    expect(await d.get("k.png")).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    await d.delete("k.png");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports failures without leaking the response or credentials", async () => {
    const d = s3Driver(cfg, (async () => new Response("<Error>SignatureDoesNotMatch test-secret</Error>", { status: 403 })) as unknown as typeof fetch);
    await expect(d.put("k", new Uint8Array([1]), "image/png", "org")).rejects.toThrow("Object storage refused the upload (HTTP 403).");
    const missing = s3Driver(cfg, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch);
    expect(await missing.get("k")).toBeNull();
    await expect(missing.delete("k")).resolves.toBeUndefined();
  });
});

describe("media storage config", () => {
  it("defaults to postgres and validates the s3 settings", () => {
    expect(mediaStorageConfig({})).toEqual({ driver: "postgres" });
    expect(mediaStorageProblems({ MEDIA_STORAGE_DRIVER: "s3" }).map((p) => p.variable)).toEqual([
      "MEDIA_S3_ENDPOINT", "MEDIA_S3_REGION", "MEDIA_S3_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY",
    ]);
    expect(mediaStorageProblems({ MEDIA_STORAGE_DRIVER: "gcs" })[0].variable).toBe("MEDIA_STORAGE_DRIVER");
    const s3 = mediaStorageConfig({ MEDIA_STORAGE_DRIVER: "s3", MEDIA_S3_ENDPOINT: "https://x", MEDIA_S3_REGION: "auto", MEDIA_S3_BUCKET: "b", MEDIA_S3_ACCESS_KEY_ID: "a", MEDIA_S3_SECRET_ACCESS_KEY: "s", MEDIA_S3_FORCE_PATH_STYLE: "false" });
    expect(s3).toMatchObject({ driver: "s3", s3: { bucket: "b", forcePathStyle: false } });
  });
});
