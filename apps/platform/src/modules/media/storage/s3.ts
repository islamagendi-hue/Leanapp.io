import { sha256Hex, signRequest, type SigV4Credentials } from "./sigv4";
import { StorageError, type StorageDriver, type StoredObject } from "./types";

/**
 * S3-compatible object storage over plain fetch with SigV4 headers: AWS S3,
 * Cloudflare R2, Supabase Storage (its S3 endpoint), MinIO. Objects are
 * written private and the bucket never needs to be public: the app serves
 * them (the authorized file route, and the durable /m/ link for public assets).
 * Not verified against a live bucket in this repository (tests mock fetch).
 */
export interface S3Config extends SigV4Credentials {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com, https://<ref>.supabase.co/storage/v1/s3, https://s3.<region>.amazonaws.com
  bucket: string;
  forcePathStyle: boolean;
}

const TIMEOUT_MS = 20_000;

export function s3ObjectUrl(cfg: Pick<S3Config, "endpoint" | "bucket" | "forcePathStyle">, key: string): URL {
  const base = new URL(cfg.endpoint.replace(/\/$/, ""));
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (cfg.forcePathStyle) {
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(cfg.bucket)}/${encodedKey}`;
    return base;
  }
  base.hostname = `${cfg.bucket}.${base.hostname}`;
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${encodedKey}`;
  return base;
}

export function s3Driver(cfg: S3Config, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): StorageDriver {
  const call = async (method: "PUT" | "GET" | "DELETE", key: string, body?: Uint8Array, contentType?: string) => {
    const url = s3ObjectUrl(cfg, key);
    const headers = signRequest(cfg, {
      method,
      url,
      headers: contentType ? { "content-type": contentType } : {},
      payloadHash: sha256Hex(body ?? new Uint8Array()),
      now: now(),
    });
    try {
      return await fetchImpl(url, { method, headers, body: body ? Buffer.from(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    } catch (e) {
      throw new StorageError(`Object storage ${method} failed: ${(e as Error).name}`);
    }
  };
  return {
    name: "s3",
    async put(key, bytes, contentType) {
      const res = await call("PUT", key, bytes, contentType);
      if (!res.ok) throw new StorageError(`Object storage refused the upload (HTTP ${res.status}).`);
    },
    async get(key): Promise<StoredObject | null> {
      const res = await call("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError(`Object storage read failed (HTTP ${res.status}).`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
    },
    async delete(key) {
      const res = await call("DELETE", key);
      if (!res.ok && res.status !== 404) throw new StorageError(`Object storage delete failed (HTTP ${res.status}).`);
    },
  };
}
