/**
 * SKAdNetwork and AdAttributionKit postbacks (pure: parsing and Apple
 * signature verification, no database). Unit-tested in skan.test.ts with
 * Apple's published example postbacks and locally generated key pairs.
 *
 * Developer copies of winning postbacks arrive at the well-known paths of the
 * registrable domain in the app's Info.plist:
 *   SKAdNetwork        NSAdvertisingAttributionReportEndpoint → POST /.well-known/skadnetwork/report-attribution/
 *   AdAttributionKit   AttributionCopyEndpoint                → POST /.well-known/appattribution/report-attribution/
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Apple's NIST P-256 public key for SKAdNetwork postbacks, versions 2.1 and later
 * (ECDSA with SHA-256 over the version-specific fields, DER signature).
 * Source: https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback
 */
export const APPLE_SKAN_P256_PUBLIC_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==";

/**
 * Apple's AdAttributionKit JWS (ES256) keys by `kid`.
 * Source: https://developer.apple.com/documentation/adattributionkit/verifying-a-postback
 *   apple-cas-identifier/0           production postbacks
 *   apple-development-identifier/0   development postbacks from end-to-end flows
 *   apple-development-identifier/1   development postbacks generated from developer settings
 */
export const APPLE_AAK_PUBLIC_KEYS: Record<string, string> = {
  "apple-cas-identifier/0": APPLE_SKAN_P256_PUBLIC_KEY,
  "apple-development-identifier/0": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELeEDzpJEP+/qRSE5hJVC1p1J0ssUnQGMzBBbvnACBok8OVGGLgxL0myrKiy6lvRtSlLRsWit87i+vftD8AEqeQ==",
  "apple-development-identifier/1": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8YzdO7eM97s/IJ25kdW5CZ3A14USE5IJ5Ha/vhWaxI6UBI1ZxCEvjrKxVluVGe6qWwF1BDFq+QHqKfH5u+wxHQ==",
};
export const AAK_PRODUCTION_KID = "apple-cas-identifier/0";

const keyCache = new Map<string, KeyObject>();
function publicKey(base64Der: string): KeyObject {
  let k = keyCache.get(base64Der);
  if (!k) {
    k = createPublicKey({ key: Buffer.from(base64Der, "base64"), format: "der", type: "spki" });
    keyCache.set(base64Der, k);
  }
  return k;
}

type Obj = Record<string, unknown>;
const SEP = "⁣";
const present = (v: unknown) => v !== undefined && v !== null && v !== "";
const str = (v: unknown) => (typeof v === "boolean" ? (v ? "true" : "false") : String(v));

/** SKAN versions whose signature layout and key this receiver knows. */
export type SkanLayout = "4" | "3" | "2.2" | "2.1";
export function skanLayout(version: unknown): SkanLayout | null {
  const v = typeof version === "string" ? version.trim() : "";
  if (/^4\.\d+$/.test(v)) return "4";
  if (v === "3.0") return "3";
  if (v === "2.2") return "2.2";
  if (v === "2.1") return "2.1"; // 2.0 and 1.0 used other keys (P-192); not accepted
  return null;
}

/**
 * The UTF-8 string Apple signs, fields joined by U+2063 in the
 * version-specific order. conversion-value / coarse-conversion-value are
 * never part of it. null when a required field is missing.
 */
export function skanSignedString(p: Obj): string | null {
  const layout = skanLayout(p.version);
  if (!layout) return null;
  const source = layout === "4" ? (present(p["source-app-id"]) ? p["source-app-id"] : p["source-domain"]) : p["source-app-id"];
  const fields: unknown[] =
    layout === "4"
      ? [p.version, p["ad-network-id"], p["source-identifier"], p["app-id"], p["transaction-id"], p.redownload, source, p["fidelity-type"], p["did-win"], p["postback-sequence-index"]]
      : layout === "3"
        ? [p.version, p["ad-network-id"], p["campaign-id"], p["app-id"], p["transaction-id"], p.redownload, source, p["fidelity-type"], p["did-win"]]
        : layout === "2.2"
          ? [p.version, p["ad-network-id"], p["campaign-id"], p["app-id"], p["transaction-id"], p.redownload, source, p["fidelity-type"]]
          : [p.version, p["ad-network-id"], p["campaign-id"], p["app-id"], p["transaction-id"], p.redownload, source];
  // The source field (index 6) is optional; every other one is required.
  const required = fields.filter((_, i) => i !== 6);
  if (!required.every(present) || typeof p.redownload !== "boolean") return null;
  return fields.filter((v, i) => i !== 6 || present(v)).map(str).join(SEP);
}

export type Verification = { valid: true } | { valid: false; reason: string };

/** Verifies a SKAdNetwork postback's attribution-signature. `keyBase64` is for tests (defaults to Apple's key). */
export function verifySkanPostback(p: Obj, keyBase64: string = APPLE_SKAN_P256_PUBLIC_KEY): Verification {
  if (!skanLayout(p.version)) return { valid: false, reason: `unsupported version ${String(p.version ?? "(missing)")}` };
  const message = skanSignedString(p);
  if (!message) return { valid: false, reason: "missing signed fields" };
  const sig = typeof p["attribution-signature"] === "string" ? p["attribution-signature"] : "";
  if (!sig) return { valid: false, reason: "missing attribution-signature" };
  try {
    return verify("sha256", Buffer.from(message, "utf8"), publicKey(keyBase64), Buffer.from(sig, "base64")) ? { valid: true } : { valid: false, reason: "signature does not match" };
  } catch {
    return { valid: false, reason: "malformed signature" };
  }
}

export interface AakVerified {
  kid: string;
  payload: Obj;
}

/** Verifies an AdAttributionKit compact JWS (ES256, kid → key). `keys` is for tests. */
export function verifyAakJws(jws: unknown, keys: Record<string, string> = APPLE_AAK_PUBLIC_KEYS): ({ valid: true } & AakVerified) | { valid: false; reason: string } {
  if (typeof jws !== "string" || jws.length > 8192) return { valid: false, reason: "missing jws-string" };
  const parts = jws.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed JWS" };
  let header: Obj;
  let payload: Obj;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed JWS" };
  }
  if (header.alg !== "ES256") return { valid: false, reason: "unsupported alg" };
  const kid = typeof header.kid === "string" ? header.kid : "";
  const key = keys[kid];
  if (!key) return { valid: false, reason: "unknown kid" };
  try {
    const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), { key: publicKey(key), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
    if (!ok) return { valid: false, reason: "signature does not match" };
  } catch {
    return { valid: false, reason: "malformed signature" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { valid: false, reason: "malformed payload" };
  return { valid: true, kid, payload };
}

/** A verified postback, normalized for storage. */
export interface SkanRecord {
  framework: "skadnetwork" | "adattributionkit";
  version: string | null;
  keyId: string | null;
  transactionId: string;
  adNetworkId: string;
  sourceIdentifier: string | null;
  appStoreId: number;
  sourceAppId: number | null;
  sourceDomain: string | null;
  redownload: boolean | null;
  conversionType: string | null;
  fidelityType: number | null;
  adInteractionType: string | null;
  didWin: boolean | null;
  sequenceIndex: number;
  fineValue: number | null;
  coarseValue: "low" | "medium" | "high" | null;
  countryCode: string | null;
  marketplaceId: string | null;
}

const int = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : null);
const fine = (v: unknown) => {
  const n = int(v);
  return n !== null && n <= 63 ? n : null;
};
const coarse = (v: unknown) => (v === "low" || v === "medium" || v === "high" ? v : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

export type ParsedPostback = { ok: true; record: SkanRecord } | { ok: false; status: 400; reason: string };

/** Parses and verifies a SKAdNetwork postback body. */
export function parseSkanPostback(body: Obj, keyBase64?: string): ParsedPostback {
  const v = verifySkanPostback(body, keyBase64);
  if (!v.valid) return { ok: false, status: 400, reason: v.reason };
  const appId = int(body["app-id"]);
  const tx = text(body["transaction-id"]);
  const net = text(body["ad-network-id"]);
  if (!appId || !tx || !net) return { ok: false, status: 400, reason: "missing app-id, transaction-id or ad-network-id" };
  return {
    ok: true,
    record: {
      framework: "skadnetwork",
      version: text(body.version, 10),
      keyId: null,
      transactionId: tx,
      adNetworkId: net,
      sourceIdentifier: text(body["source-identifier"], 10) ?? text(body["campaign-id"], 10),
      appStoreId: appId,
      sourceAppId: int(body["source-app-id"]),
      sourceDomain: text(body["source-domain"]),
      redownload: bool(body.redownload),
      conversionType: body.redownload === true ? "redownload" : "download",
      fidelityType: int(body["fidelity-type"]),
      adInteractionType: body["fidelity-type"] === 1 ? "click" : body["fidelity-type"] === 0 ? "view" : null,
      didWin: bool(body["did-win"]) ?? true, // versions before 3 only sent winning postbacks
      sequenceIndex: int(body["postback-sequence-index"]) ?? 0,
      fineValue: fine(body["conversion-value"]),
      coarseValue: coarse(body["coarse-conversion-value"]),
      countryCode: null,
      marketplaceId: null,
    },
  };
}

/** Parses and verifies an AdAttributionKit postback body ({"jws-string": …, "conversion-value": …}). */
export function parseAakPostback(body: Obj, keys?: Record<string, string>): ParsedPostback {
  const v = verifyAakJws(body["jws-string"], keys);
  if (!v.valid) return { ok: false, status: 400, reason: v.reason };
  const p = v.payload;
  const appId = int(p["advertised-item-identifier"]);
  const tx = text(p["postback-identifier"]);
  const net = text(p["ad-network-identifier"]);
  if (!appId || !tx || !net) return { ok: false, status: 400, reason: "missing advertised-item-identifier, postback-identifier or ad-network-identifier" };
  const cc = text(body["country-code"], 2);
  const interaction = text(body["ad-interaction-type"], 20);
  return {
    ok: true,
    record: {
      framework: "adattributionkit",
      version: null,
      keyId: v.kid,
      transactionId: tx,
      adNetworkId: net,
      sourceIdentifier: text(p["source-identifier"], 10),
      appStoreId: appId,
      sourceAppId: int(p["publisher-item-identifier"]) || null,
      sourceDomain: null,
      redownload: p["conversion-type"] === "redownload",
      conversionType: text(p["conversion-type"], 30),
      fidelityType: interaction === "click" ? 1 : interaction === "view" ? 0 : null,
      adInteractionType: interaction,
      didWin: bool(p["did-win"]),
      sequenceIndex: int(p["postback-sequence-index"]) ?? 0,
      fineValue: fine(body["conversion-value"]),
      coarseValue: coarse(body["coarse-conversion-value"]),
      countryCode: cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null,
      marketplaceId: text(p["marketplace-identifier"]),
    },
  };
}

/**
 * SKAdNetwork ids that ad networks publish for advertised apps' Info.plist
 * (SKAdNetworkItems). Only ids we are confident of are listed (Meta's two,
 * Google's and Snap's); for TikTok and X the readiness checklist asks the
 * customer to compare with the network's current list. Networks add ids over
 * time: always copy the full list from the network's documentation.
 */
export const KNOWN_SKAN_IDS: Record<string, { ids: string[]; doc: string | null }> = {
  meta: { ids: ["v9wttpbfk9.skadnetwork", "n38lu8286q.skadnetwork"], doc: "https://developers.facebook.com/docs/SKAdNetwork" },
  google: { ids: ["cstr6suwn9.skadnetwork"], doc: "https://developers.google.com/admob/ios/ios14" },
  snapchat: { ids: ["424m5254lk.skadnetwork"], doc: null },
  tiktok: { ids: [], doc: null },
  x: { ids: [], doc: null },
};

/** The ad network an SKAdNetwork id belongs to, when known. */
export function networkOfSkanId(id: string): string | null {
  const lower = id.trim().toLowerCase();
  for (const [network, k] of Object.entries(KNOWN_SKAN_IDS)) if (k.ids.includes(lower)) return network;
  return null;
}

export const SKAN_ID = /^[a-z0-9]{6,20}\.skadnetwork$/;
