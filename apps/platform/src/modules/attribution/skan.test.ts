import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as fx from "../../../test/fixtures/skan";
import { networkOfSkanId, parseAakPostback, parseSkanPostback, skanLayout, skanSignedString, verifyAakJws, verifySkanPostback } from "./skan";

/** A local P-256 key pair standing in for Apple's, so every version layout can be signed and checked. */
const local = generateKeyPairSync("ec", { namedCurve: "P-256" });
const localPublic = local.publicKey.export({ format: "der", type: "spki" }).toString("base64");
function signSkan(p: Record<string, unknown>) {
  const msg = skanSignedString(p);
  if (!msg) throw new Error("unsignable");
  return { ...p, "attribution-signature": sign("sha256", Buffer.from(msg, "utf8"), local.privateKey).toString("base64") };
}
function signJws(header: object, payload: object) {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = sign("sha256", Buffer.from(`${h}.${p}`), { key: local.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${s}`;
}

describe("SKAdNetwork signature verification with Apple's key", () => {
  it("accepts Apple's published examples (4.0 fine and coarse, 3.0 win and loss, 2.2)", () => {
    for (const p of [fx.skan4Fine, fx.skan4Coarse, fx.skan3Win, fx.skan3Loss, fx.skan22]) expect(verifySkanPostback(p), p.version).toEqual({ valid: true });
  });

  it("rejects tampered signed fields", () => {
    expect(verifySkanPostback({ ...fx.skan4Fine, "source-identifier": "5240" }).valid).toBe(false);
    expect(verifySkanPostback({ ...fx.skan4Fine, "app-id": 525463030 }).valid).toBe(false);
    expect(verifySkanPostback({ ...fx.skan4Fine, "did-win": false }).valid).toBe(false);
    expect(verifySkanPostback({ ...fx.skan3Win, "campaign-id": 43 }).valid).toBe(false);
    expect(verifySkanPostback({ ...fx.skan4Fine, "attribution-signature": fx.skan4Coarse["attribution-signature"] }).valid).toBe(false);
    expect(verifySkanPostback({ ...fx.skan4Fine, "attribution-signature": "bm90IGEgc2lnbmF0dXJl" }).valid).toBe(false);
  });

  it("does not cover conversion values (Apple doesn't sign them)", () => {
    expect(verifySkanPostback({ ...fx.skan4Fine, "conversion-value": 1 }).valid).toBe(true);
  });

  it("refuses unknown versions and missing fields", () => {
    expect(verifySkanPostback({ ...fx.skan4Fine, version: "1.0" })).toEqual({ valid: false, reason: "unsupported version 1.0" });
    expect(verifySkanPostback({ ...fx.skan4Fine, version: "2.0" }).valid).toBe(false);
    const noTx: Record<string, unknown> = { ...fx.skan4Fine };
    delete noTx["transaction-id"];
    expect(verifySkanPostback(noTx)).toEqual({ valid: false, reason: "missing signed fields" });
    expect(verifySkanPostback({ ...fx.skan4Fine, redownload: "false" }).valid).toBe(false);
  });
});

describe("SKAdNetwork version switch (local key pair)", () => {
  const base = { "ad-network-id": "abc123.skadnetwork", "app-id": 111, "transaction-id": "tx", redownload: false, "fidelity-type": 1 };
  it("signs and verifies each layout, with and without the source field", () => {
    const cases: Record<string, unknown>[] = [
      { ...base, version: "4.0", "source-identifier": "1234", "source-app-id": 5, "did-win": true, "postback-sequence-index": 1 },
      { ...base, version: "4.0", "source-identifier": "12", "did-win": false, "postback-sequence-index": 2 },
      { ...base, version: "4.1", "source-identifier": "12", "source-domain": "example.com", "did-win": true, "postback-sequence-index": 0 },
      { ...base, version: "3.0", "campaign-id": 7, "source-app-id": 5, "did-win": true },
      { ...base, version: "2.2", "campaign-id": 7 },
      { ...base, version: "2.1", "campaign-id": 7, "source-app-id": 5 },
    ];
    for (const c of cases) {
      const signed = signSkan(c);
      expect(verifySkanPostback(signed, localPublic), String(c.version)).toEqual({ valid: true });
      // Apple's key does not verify a locally signed postback.
      expect(verifySkanPostback(signed).valid).toBe(false);
    }
  });

  it("uses the version's own field order", () => {
    const sep = "⁣";
    expect(skanSignedString({ ...base, version: "4.0", "source-identifier": "12", "did-win": true, "postback-sequence-index": 0 }))
      .toBe(["4.0", "abc123.skadnetwork", "12", "111", "tx", "false", "1", "true", "0"].join(sep));
    expect(skanSignedString({ ...base, version: "3.0", "campaign-id": 7, "source-app-id": 5, "did-win": false }))
      .toBe(["3.0", "abc123.skadnetwork", "7", "111", "tx", "false", "5", "1", "false"].join(sep));
    expect(skanSignedString({ ...base, version: "2.2", "campaign-id": 7 })).toBe(["2.2", "abc123.skadnetwork", "7", "111", "tx", "false", "1"].join(sep));
    // A 3.0 postback signed with the 4.0 layout must not verify.
    const p4 = signSkan({ ...base, version: "4.0", "source-identifier": "7", "did-win": true, "postback-sequence-index": 0 });
    expect(verifySkanPostback({ ...p4, version: "3.0", "campaign-id": 7 }, localPublic).valid).toBe(false);
    expect(skanLayout("5.0")).toBeNull();
  });
});

describe("AdAttributionKit JWS", () => {
  it("accepts Apple's published development postback and parses it", () => {
    const v = verifyAakJws(fx.aakDev["jws-string"]);
    expect(v).toMatchObject({ valid: true, kid: "apple-development-identifier/1" });
    const r = parseAakPostback(fx.aakDev);
    expect(r).toMatchObject({
      ok: true,
      record: {
        framework: "adattributionkit", appStoreId: fx.AAK_APP_ID, adNetworkId: "development.adattributionkit", sourceIdentifier: "1234",
        conversionType: "re-engagement", fineValue: 24, countryCode: "US", adInteractionType: "click", didWin: true, keyId: "apple-development-identifier/1",
        transactionId: "85546EB7-FD39-44BC-8990-C98A4AC36A49",
      },
    });
  });

  it("rejects tampering, unknown kids and other algorithms", () => {
    const [h, p, s] = fx.aakDev["jws-string"].split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    const tampered = Buffer.from(JSON.stringify({ ...payload, "source-identifier": "9999" })).toString("base64url");
    expect(verifyAakJws(`${h}.${tampered}.${s}`)).toMatchObject({ valid: false, reason: "signature does not match" });
    expect(verifyAakJws(signJws({ alg: "ES256", kid: "apple-cas-identifier/0" }, payload))).toMatchObject({ valid: false });
    expect(verifyAakJws(signJws({ alg: "ES256", kid: "local/0" }, payload), { "local/0": localPublic })).toMatchObject({ valid: true, kid: "local/0" });
    expect(verifyAakJws(signJws({ alg: "ES256", kid: "nope" }, payload), { "local/0": localPublic })).toMatchObject({ valid: false, reason: "unknown kid" });
    expect(verifyAakJws(signJws({ alg: "HS256", kid: "local/0" }, payload), { "local/0": localPublic })).toMatchObject({ valid: false, reason: "unsupported alg" });
    expect(verifyAakJws("a.b")).toMatchObject({ valid: false });
  });
});

describe("parsing", () => {
  it("normalizes SKAN 4 and 3 postbacks", () => {
    expect(parseSkanPostback(fx.skan4Coarse)).toMatchObject({
      ok: true, record: { framework: "skadnetwork", version: "4.0", sourceIdentifier: "39", coarseValue: "high", fineValue: null, sequenceIndex: 0, sourceDomain: "example.com", appStoreId: fx.APPLE_APP_ID },
    });
    expect(parseSkanPostback(fx.skan3Win)).toMatchObject({ ok: true, record: { sourceIdentifier: "42", fineValue: 20, sourceAppId: 1234567891, redownload: true, didWin: true } });
    expect(parseSkanPostback({ ...fx.skan4Fine, "transaction-id": "x" })).toMatchObject({ ok: false, status: 400 });
  });

  it("knows the ad networks' published SKAdNetwork ids", () => {
    expect(networkOfSkanId("v9wttpbfk9.skadnetwork")).toBe("meta");
    expect(networkOfSkanId("CSTR6SUWN9.skadnetwork")).toBe("google");
    expect(networkOfSkanId("example123.skadnetwork")).toBeNull();
  });
});
