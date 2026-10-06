import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { deploymentOf } from "@/server/config";
import { isPrivateAddress } from "./signing";

/**
 * Outbound POST to a customer-supplied URL.
 *
 * SSRF protection: on deployments, the URL may not resolve to a private,
 * loopback or link-local address (e.g. cloud metadata). The check runs in the
 * socket's DNS lookup, so the address that is checked is the one connected to
 * (no DNS-rebinding gap). Redirects are not followed. Locally (tests, dev) or
 * with WEBHOOK_ALLOW_PRIVATE_NETWORKS=1, private addresses are allowed.
 */
export function privateNetworksAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return deploymentOf(env) === "local" || env.WEBHOOK_ALLOW_PRIVATE_NETWORKS === "1";
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`Refused to connect to ${host}: it resolves to a private or reserved address.`);
  }
}

export interface PostResult {
  status: number | null;
  body: string;
  error: string | null;
  durationMs: number;
}

const MAX_RESPONSE_BYTES = 2048;

export function postJson(url: string, body: string, headers: Record<string, string>, opts: { timeoutMs?: number } = {}): Promise<PostResult> {
  const started = Date.now();
  const allowPrivate = privateNetworksAllowed();
  return new Promise((resolve) => {
    const done = (r: Omit<PostResult, "durationMs">) => resolve({ ...r, durationMs: Date.now() - started });
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return done({ status: null, body: "", error: "invalid_url" });
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return done({ status: null, body: "", error: "invalid_url" });
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) return done({ status: null, body: "", error: new BlockedAddressError(host).message });

    const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
        if (err) return cb(err, "");
        if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) return cb(new BlockedAddressError(hostname), "");
        if ((options as { all?: boolean }).all) return cb(null, addresses);
        cb(null, addresses[0].address, addresses[0].family);
      });
    };

    const mod = target.protocol === "https:" ? https : http;
    const req = mod.request(
      target,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString(), "User-Agent": "LeanApp-Webhooks/1.0", ...headers },
        lookup: lookup as never,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) chunks.push(c.subarray(0, MAX_RESPONSE_BYTES - size));
          size += c.length;
        });
        res.on("end", () => done({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8"), error: null }));
        res.on("error", (e) => done({ status: res.statusCode ?? null, body: "", error: e.message }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ status: null, body: "", error: e.message.slice(0, 300) }));
    req.end(body);
  });
}
