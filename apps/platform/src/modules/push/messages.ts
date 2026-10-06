/**
 * Push request construction for FCM HTTP v1 and APNs (token-based auth),
 * with no SDKs: JWTs are signed with node:crypto. Pure functions, unit tested
 * against the providers' documented formats. NOT verified against live FCM or
 * APNs (no Google/Apple accounts in this project); see docs/automation.md.
 *
 *   FCM:  service-account JWT (RS256) → OAuth access token at token_uri →
 *         POST https://fcm.googleapis.com/v1/projects/{project}/messages:send
 *   APNs: provider JWT (ES256, kid = key id, iss = team id), reused ≤ 50 min →
 *         POST /3/device/{token} over HTTP/2 with apns-topic = bundle id
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** Parses and checks a Firebase service-account JSON file. Throws with a readable message. */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("The service account file is not valid JSON.");
  }
  if (raw.type !== "service_account") throw new Error('This is not a service account key (expected "type": "service_account").');
  for (const k of ["project_id", "client_email", "private_key"]) {
    if (typeof raw[k] !== "string" || !raw[k]) throw new Error(`The service account file has no ${k}.`);
  }
  try {
    const key = createPrivateKey(raw.private_key as string);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw new Error("The service account private_key is not a valid RSA private key.");
  }
  return {
    project_id: raw.project_id as string,
    client_email: raw.client_email as string,
    private_key: raw.private_key as string,
    token_uri: typeof raw.token_uri === "string" && raw.token_uri ? raw.token_uri : GOOGLE_TOKEN_URI,
  };
}

function jwt(header: object, claims: object, signer: (data: Buffer) => Buffer): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(signer(Buffer.from(input)))}`;
}

/** The signed assertion exchanged for an access token (RFC 7523 JWT bearer grant). */
export function fcmAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const key = createPrivateKey(sa.private_key);
  return jwt(
    { alg: "RS256", typ: "JWT" },
    { iss: sa.client_email, scope: FCM_SCOPE, aud: sa.token_uri, iat: nowSeconds, exp: nowSeconds + 3600 },
    (data) => sign("RSA-SHA256", data, key),
  );
}

export function fcmTokenRequest(sa: ServiceAccount, nowSeconds: number): { url: string; body: string; headers: Record<string, string> } {
  return {
    url: sa.token_uri,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: fcmAssertion(sa, nowSeconds) }).toString(),
  };
}

export interface PushContent {
  title: string;
  body: string;
  /** Custom key/values delivered to the app (deep link etc.). */
  data?: Record<string, string>;
}

export function fcmSendRequest(base: string, projectId: string, accessToken: string, token: string, msg: PushContent) {
  return {
    url: `${base.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        ...(msg.data && Object.keys(msg.data).length ? { data: msg.data } : {}),
        android: { priority: "high" },
        apns: { payload: { aps: { sound: "default" } } },
      },
    }),
  };
}

/** FCM error responses that mean the token will never work again. */
export function fcmTokenInvalid(status: number, body: string): boolean {
  if (status === 404) return true;
  try {
    const err = JSON.parse(body)?.error as { status?: string; message?: string; details?: { errorCode?: string }[] } | undefined;
    const codes = (err?.details ?? []).map((d) => d.errorCode);
    if (codes.includes("UNREGISTERED") || codes.includes("SENDER_ID_MISMATCH")) return true;
    if (status === 400 && err?.status === "INVALID_ARGUMENT" && /registration token/i.test(err.message ?? "")) return true;
  } catch {
    /* not JSON */
  }
  return false;
}

// ── APNs ────────────────────────────────────────────────────────────────────
export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  privateKey: string; // .p8 contents (PKCS#8 PEM, EC P-256)
  bundleId: string;
  environment: "production" | "sandbox";
}

export function parseApnsKey(p8: string): KeyObject {
  try {
    const key = createPrivateKey(p8);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    return key;
  } catch {
    throw new Error("The .p8 file is not an APNs auth key (EC P-256 private key in PEM format).");
  }
}

/** Provider authentication token. Apple accepts one for up to an hour; reuse it rather than signing per request. */
export function apnsToken(c: Pick<ApnsCredentials, "keyId" | "teamId" | "privateKey">, nowSeconds: number): string {
  const key = parseApnsKey(c.privateKey);
  return jwt({ alg: "ES256", kid: c.keyId }, { iss: c.teamId, iat: nowSeconds }, (data) => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }));
}

export const APNS_HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;

export function apnsRequest(c: Pick<ApnsCredentials, "bundleId">, providerToken: string, deviceToken: string, msg: PushContent, opts: { id?: string } = {}) {
  return {
    path: `/3/device/${encodeURIComponent(deviceToken)}`,
    headers: {
      ":method": "POST",
      authorization: `bearer ${providerToken}`,
      "apns-topic": c.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      ...(opts.id ? { "apns-id": opts.id } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: "default" }, ...(msg.data ?? {}) }),
  };
}

/** APNs responses that mean the device token is dead (uninstalled app, wrong app or environment). */
export function apnsTokenInvalid(status: number, body: string): boolean {
  if (status === 410) return true;
  try {
    const reason = JSON.parse(body)?.reason;
    return ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(reason);
  } catch {
    return false;
  }
}
