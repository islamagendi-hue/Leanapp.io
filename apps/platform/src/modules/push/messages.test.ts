import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apnsRequest, apnsToken, apnsTokenInvalid, fcmSendRequest, fcmTokenInvalid, fcmTokenRequest, parseApnsKey, parseServiceAccount, FCM_SCOPE } from "./messages";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const sa = {
  type: "service_account",
  project_id: "demo-app",
  client_email: "push@demo-app.iam.gserviceaccount.com",
  private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("FCM HTTP v1", () => {
  it("parses a service account and defaults token_uri", () => {
    expect(parseServiceAccount(JSON.stringify(sa)).token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(() => parseServiceAccount("{")).toThrow(/JSON/);
    expect(() => parseServiceAccount(JSON.stringify({ ...sa, type: "user" }))).toThrow(/service account/);
    expect(() => parseServiceAccount(JSON.stringify({ ...sa, private_key: "nope" }))).toThrow(/RSA/);
  });

  it("builds an RS256 JWT-bearer assertion for the messaging scope", () => {
    const req = fcmTokenRequest(parseServiceAccount(JSON.stringify(sa)), 1_700_000_000);
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(req.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".");
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(c)).toEqual({ iss: sa.client_email, scope: FCM_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("builds the send request", () => {
    const r = fcmSendRequest("https://fcm.googleapis.com", "demo-app", "ya29.token", "device-token", { title: "Hi", body: "There", data: { deep_link: "app://x" } });
    expect(r.url).toBe("https://fcm.googleapis.com/v1/projects/demo-app/messages:send");
    expect(r.headers.Authorization).toBe("Bearer ya29.token");
    expect(JSON.parse(r.body).message).toMatchObject({ token: "device-token", notification: { title: "Hi", body: "There" }, data: { deep_link: "app://x" } });
  });

  it("recognises dead tokens", () => {
    expect(fcmTokenInvalid(404, JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }))).toBe(true);
    expect(fcmTokenInvalid(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }))).toBe(true);
    expect(fcmTokenInvalid(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload" } }))).toBe(false);
    expect(fcmTokenInvalid(503, "oops")).toBe(false);
  });
});

describe("APNs token auth", () => {
  const p8 = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("signs an ES256 provider token with kid and iss", () => {
    const token = apnsToken({ keyId: "ABC123DEFG", teamId: "TEAM123456", privateKey: p8 }, 1_700_000_000);
    const [h, c, s] = token.split(".");
    expect(decode(h)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decode(c)).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
    expect(Buffer.from(s, "base64url").length).toBe(64); // raw r||s, not DER
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("only accepts P-256 keys", () => {
    expect(() => parseApnsKey(sa.private_key)).toThrow(/P-256/);
    expect(() => parseApnsKey("garbage")).toThrow();
  });

  it("builds the HTTP/2 request", () => {
    const r = apnsRequest({ bundleId: "com.example.app" }, "jwt", "abcdef", { title: "Hi", body: "There", data: { deep_link: "app://x" } });
    expect(r.path).toBe("/3/device/abcdef");
    expect(r.headers).toMatchObject({ ":method": "POST", authorization: "bearer jwt", "apns-topic": "com.example.app", "apns-push-type": "alert", "apns-priority": "10" });
    expect(JSON.parse(r.body)).toEqual({ aps: { alert: { title: "Hi", body: "There" }, sound: "default" }, deep_link: "app://x" });
  });

  it("recognises dead tokens", () => {
    expect(apnsTokenInvalid(410, '{"reason":"Unregistered"}')).toBe(true);
    expect(apnsTokenInvalid(400, '{"reason":"BadDeviceToken"}')).toBe(true);
    expect(apnsTokenInvalid(400, '{"reason":"PayloadTooLarge"}')).toBe(false);
    expect(apnsTokenInvalid(403, '{"reason":"ExpiredProviderToken"}')).toBe(false);
  });
});
