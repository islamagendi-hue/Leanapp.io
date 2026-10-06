import "server-only";
import http2 from "node:http2";
import { deploymentOf } from "@/server/config";
import {
  APNS_HOSTS, apnsRequest, apnsToken, apnsTokenInvalid, fcmSendRequest, fcmTokenInvalid, fcmTokenRequest, GOOGLE_TOKEN_URI,
  type ApnsCredentials, type PushContent, type ServiceAccount,
} from "./messages";

/**
 * Sends push notifications to FCM (fetch) and APNs (node:http2). Provider
 * endpoints can be pointed at local mocks with FCM_API_BASE_URL / APNS_BASE_URL
 * and a service account's token_uri, but only outside deployments, so a
 * customer-supplied token_uri can never make production call arbitrary hosts.
 */
export interface PushOutcome {
  ok: boolean;
  /** The provider says this device token is dead: deactivate it. */
  invalidToken: boolean;
  status: number | null;
  error: string | null;
  providerId?: string;
}

const local = () => deploymentOf(process.env) === "local";
export function fcmBaseUrl(): string {
  return (local() && process.env.FCM_API_BASE_URL) || "https://fcm.googleapis.com";
}
export function apnsBaseUrl(env: ApnsCredentials["environment"]): string {
  return (local() && process.env.APNS_BASE_URL) || APNS_HOSTS[env];
}
/** Deployments only talk to Google's token endpoint, whatever the uploaded file says. */
export function allowedTokenUri(uri: string): boolean {
  return uri === GOOGLE_TOKEN_URI || local();
}

// ── FCM ─────────────────────────────────────────────────────────────────────
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  if (!allowedTokenUri(sa.token_uri)) throw new Error("token_uri must be Google's OAuth endpoint");
  const cacheKey = `${sa.client_email}|${sa.token_uri}`;
  const cached = accessTokens.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const req = fcmTokenRequest(sa, Math.floor(Date.now() / 1000));
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth token request failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("OAuth token response had no access_token");
  accessTokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export async function sendFcm(sa: ServiceAccount, deviceToken: string, msg: PushContent): Promise<PushOutcome> {
  try {
    const access = await fcmAccessToken(sa);
    const req = fcmSendRequest(fcmBaseUrl(), sa.project_id, access, deviceToken, msg);
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (res.ok) return { ok: true, invalidToken: false, status: res.status, error: null, providerId: (JSON.parse(text) as { name?: string }).name };
    if (res.status === 401) accessTokens.delete(`${sa.client_email}|${sa.token_uri}`);
    return { ok: false, invalidToken: fcmTokenInvalid(res.status, text), status: res.status, error: `FCM ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, invalidToken: false, status: null, error: (err as Error).message.slice(0, 300) };
  }
}

// ── APNs ────────────────────────────────────────────────────────────────────
const providerTokens = new Map<string, { token: string; issuedAt: number }>();
const sessions = new Map<string, http2.ClientHttp2Session>();

function providerToken(c: ApnsCredentials): string {
  const key = `${c.teamId}|${c.keyId}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = providerTokens.get(key);
  if (cached && now - cached.issuedAt < 50 * 60) return cached.token;
  const token = apnsToken(c, now);
  providerTokens.set(key, { token, issuedAt: now });
  return token;
}

function session(origin: string): http2.ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const s = http2.connect(origin);
  s.on("error", () => sessions.delete(origin));
  s.on("close", () => sessions.delete(origin));
  s.setTimeout(60_000, () => s.close());
  s.unref();
  sessions.set(origin, s);
  return s;
}

export function sendApns(c: ApnsCredentials, deviceToken: string, msg: PushContent): Promise<PushOutcome> {
  return new Promise((resolve) => {
    let req: http2.ClientHttp2Stream;
    try {
      const r = apnsRequest(c, providerToken(c), deviceToken, msg);
      req = session(apnsBaseUrl(c.environment)).request({ ...r.headers, ":path": r.path });
      req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let apnsId: string | undefined;
      const chunks: Buffer[] = [];
      req.on("response", (h) => {
        status = Number(h[":status"]);
        apnsId = h["apns-id"] as string | undefined;
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (status === 200) resolve({ ok: true, invalidToken: false, status, error: null, providerId: apnsId });
        else {
          if (status === 403) providerTokens.delete(`${c.teamId}|${c.keyId}`);
          resolve({ ok: false, invalidToken: apnsTokenInvalid(status, body), status: status || null, error: `APNs ${status}: ${body.slice(0, 200)}` });
        }
      });
      req.on("error", (e) => resolve({ ok: false, invalidToken: false, status: null, error: e.message.slice(0, 300) }));
      req.end(r.body);
    } catch (err) {
      resolve({ ok: false, invalidToken: false, status: null, error: (err as Error).message.slice(0, 300) });
    }
  });
}

/** Test hook: forget cached tokens and sessions. */
export function resetPushCaches() {
  accessTokens.clear();
  providerTokens.clear();
  for (const s of sessions.values()) s.destroy();
  sessions.clear();
}
