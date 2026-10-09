/**
 * AWS Signature Version 4 for S3-compatible object storage (AWS S3,
 * Cloudflare R2, Supabase Storage's S3 endpoint, MinIO), with node:crypto and
 * no SDK. Signs a request with headers (Authorization), never a query-string
 * presigned URL: nothing short-lived is handed out. Pure.
 * Reference: docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string; // "s3"
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  now: Date;
}

export const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (unreserved characters kept; "/" kept in paths). */
export function uriEncode(s: string, keepSlash: boolean): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { long, short: long.slice(0, 8) };
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

export function canonicalRequest(input: SignInput): { request: string; signedHeaders: string } {
  const { method, url, headers, payloadHash } = input;
  // Path segments arrive already decoded from URL; S3 wants each segment encoded once.
  const path = url.pathname.split("/").map((seg) => uriEncode(decodeURIComponent(seg), false)).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const request = [method.toUpperCase(), path, query, entries.map(([k, v]) => `${k}:${v}\n`).join(""), signedHeaders, payloadHash].join("\n");
  return { request, signedHeaders };
}

/** Headers to send: the input headers plus host, x-amz-date, x-amz-content-sha256 and Authorization. */
export function signRequest(creds: SigV4Credentials, input: Omit<SignInput, "headers"> & { headers?: Record<string, string> }): Record<string, string> {
  const service = creds.service ?? "s3";
  const { long, short } = amzDate(input.now);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: input.url.host,
    "x-amz-date": long,
    "x-amz-content-sha256": input.payloadHash,
  };
  const { request, signedHeaders } = canonicalRequest({ ...input, headers });
  const scope = `${short}/${creds.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", long, scope, sha256Hex(request)].join("\n");
  const signature = createHmac("sha256", signingKey(creds.secretAccessKey, short, creds.region, service)).update(toSign).digest("hex");
  const { host: _host, ...rest } = headers;
  void _host; // fetch sets Host itself
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}
