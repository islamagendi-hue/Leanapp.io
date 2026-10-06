/**
 * SKAdNetwork / AdAttributionKit against Postgres: Apple's signed example
 * postbacks through the receiver (verification, App Store id routing,
 * idempotency, environment routing), App Store id claims, per-source reports,
 * conversion value schemas served to SDK keys, permissions and tenant isolation.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as schemaRoute } from "@/app/v1/skan/conversion-schema/route";
import { withSystem } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { skanSignedString } from "@/modules/attribution/skan";
import { EXAMPLE_SCHEMA } from "@/modules/attribution/skan-schema";
import {
  deleteConversionSchema, getConversionSchema, getSkanSettings, handleSkanPostback, saveConversionSchema, skanBySource, updateSkanSettings,
} from "@/modules/attribution/skan-service";
import * as skan from "./fixtures/skan";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let ipSeq = 0;

beforeAll(async () => {
  t = await makeTenant("skan");
  other = await makeTenant("skan-other");
});

describe("SKAdNetwork / AdAttributionKit", () => {
  const post = (framework: "skadnetwork" | "adattributionkit", body: unknown, opts = {}) => handleSkanPostback(framework, JSON.stringify(body), `203.0.113.${++ipSeq % 250}`, opts);

  it("answers 404 for an App Store id no app has claimed (Apple retries)", async () => {
    expect((await post("skadnetwork", skan.skan4Fine)).status).toBe(404);
  });

  it("claims App Store ids once across LeanApp", async () => {
    await updateSkanSettings(t.ctx, t.app.id, { appStoreId: `id${skan.APPLE_APP_ID}`, networkIds: "v9wttpbfk9.skadnetwork\ncstr6suwn9.skadnetwork  example123.skadnetwork" });
    expect(await getSkanSettings(t.ctx, t.app.id)).toEqual({
      ios_app_store_id: String(skan.APPLE_APP_ID), skan_network_ids: ["v9wttpbfk9.skadnetwork", "cstr6suwn9.skadnetwork", "example123.skadnetwork"],
    });
    await expect(updateSkanSettings(other.ctx, other.app.id, { appStoreId: String(skan.APPLE_APP_ID) })).rejects.toThrow(/already connected/);
    await expect(updateSkanSettings(t.ctx, t.app.id, { appStoreId: "abc" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSkanSettings(t.ctx, t.app.id, { appStoreId: String(skan.APPLE_APP_ID), networkIds: "bad!.skadnetwork" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSkanSettings({ ...t.ctx, role: "analyst" }, t.app.id, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stores Apple-signed postbacks in production, once per transaction", async () => {
    const prod = t.environments.find((e) => e.type === "production")!;
    for (const p of [skan.skan4Fine, skan.skan4Coarse, skan.skan3Win, skan.skan3Loss]) expect((await post("skadnetwork", p)).body, p.version).toEqual({ ok: true, duplicate: false });
    expect((await post("skadnetwork", skan.skan4Fine)).body).toEqual({ ok: true, duplicate: true });
    const rows = await withSystem((db) => db.query<{ environment_id: string; source_identifier: string; fine_value: number | null; coarse_value: string | null; did_win: boolean }>(
      "select environment_id, source_identifier, fine_value, coarse_value, did_win from platform.skan_postbacks where app_id = $1 order by source_identifier", [t.app.id]));
    expect(rows.every((r) => r.environment_id === prod.id)).toBe(true);
    expect(rows.map((r) => [r.source_identifier, r.fine_value, r.coarse_value, r.did_win])).toEqual([
      ["39", null, "high", true], ["42", 20, null, true], ["42", null, null, false], ["5239", 63, null, true],
    ]);
  });

  it("refuses unsigned, tampered and malformed postbacks", async () => {
    expect(await post("skadnetwork", { ...skan.skan4Fine, "transaction-id": "forged", "attribution-signature": undefined })).toMatchObject({ status: 400 });
    expect(await post("skadnetwork", { ...skan.skan4Fine, "source-identifier": "1111" })).toMatchObject({ status: 400, body: { error: "invalid_signature" } });
    expect((await handleSkanPostback("skadnetwork", "{not json", "203.0.113.1")).status).toBe(400);
    expect((await handleSkanPostback("skadnetwork", "x".repeat(20_000), "203.0.113.2")).status).toBe(413);
    // A postback signed by anyone but Apple fails, even when well-formed.
    const fake = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = { ...skan.skan4Fine, "transaction-id": "forged-2" };
    const sig = sign("sha256", Buffer.from(skanSignedString(forged)!, "utf8"), fake.privateKey).toString("base64");
    expect((await post("skadnetwork", { ...forged, "attribution-signature": sig })).status).toBe(400);
    // …and passes only when that key is (in a test) trusted, which proves the routing after verification.
    const trusted = await post("skadnetwork", { ...forged, "attribution-signature": sig }, { skanKey: fake.publicKey.export({ format: "der", type: "spki" }).toString("base64") });
    expect(trusted.status).toBe(200);
  });

  it("routes AdAttributionKit development postbacks to development", async () => {
    await updateSkanSettings(other.ctx, other.app.id, { appStoreId: String(skan.AAK_APP_ID) });
    expect((await post("adattributionkit", skan.aakDev)).body).toEqual({ ok: true, duplicate: false });
    const row = await withSystem((db) => db.one<{ environment_id: string; framework: string; conversion_type: string }>(
      "select environment_id, framework, conversion_type from platform.skan_postbacks where app_id = $1", [other.app.id]));
    expect(row).toEqual({ environment_id: other.dev.id, framework: "adattributionkit", conversion_type: "re-engagement" });
    const [h, p, s] = skan.aakDev["jws-string"].split(".");
    expect((await post("adattributionkit", { ...skan.aakDev, "jws-string": `${h}.${p}x.${s}` })).status).toBe(400);
  });

  it("reports postbacks per network and source identifier, per tenant", async () => {
    const prod = t.environments.find((e) => e.type === "production")!;
    const rows = await skanBySource(t.ctx, prod.id, 30);
    expect(rows.find((r) => r.source_identifier === "42")).toMatchObject({ ad_network_id: "example123.skadnetwork", postbacks: 2, wins: 1, redownloads: 2, fine_avg: 20 });
    expect(rows.find((r) => r.source_identifier === "39")).toMatchObject({ coarse_high: 1, first: 1 });
    expect(await skanBySource(other.ctx, prod.id, 30)).toEqual([]);
    expect(await skanBySource(t.ctx, t.dev.id, 30)).toEqual([]);
  });

  it("serves the conversion value schema to the SDK", async () => {
    const fetchSchema = (key: string) => schemaRoute(new Request("https://api.leanapp.io/v1/skan/conversion-schema", { headers: { authorization: `Bearer ${key}` } }));
    expect(await (await fetchSchema(t.sdkKey)).json()).toEqual({ schema: null, revision: null, updated_at: null });
    expect((await fetchSchema("la_pk_dev_nope")).status).toBe(401);

    await expect(saveConversionSchema(t.ctx, t.app.id, { rules: [{ window: 1, event: "x", fine: 3 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveConversionSchema({ ...t.ctx, role: "analyst" }, t.app.id, EXAMPLE_SCHEMA)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveConversionSchema(other.ctx, t.app.id, EXAMPLE_SCHEMA)).rejects.toBeInstanceOf(NotFoundError);
    expect((await saveConversionSchema(t.ctx, t.app.id, JSON.stringify(EXAMPLE_SCHEMA))).revision).toBe(1);
    expect((await saveConversionSchema(t.ctx, t.app.id, EXAMPLE_SCHEMA)).revision).toBe(2);

    const res = await fetchSchema(t.sdkKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ schema: EXAMPLE_SCHEMA, revision: 2 });
    // Another tenant's key gets its own app's (empty) schema.
    expect(await (await fetchSchema(other.sdkKey)).json()).toMatchObject({ schema: null });
    expect(await getConversionSchema(other.ctx, t.app.id)).toBeNull();
    await deleteConversionSchema(t.ctx, t.app.id);
    expect(await getConversionSchema(t.ctx, t.app.id)).toBeNull();
  });
});
