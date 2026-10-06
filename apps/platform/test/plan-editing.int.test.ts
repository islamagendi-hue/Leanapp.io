/**
 * Hand edits to the tracking plan against Postgres: edits land on drafts,
 * approved / published versions never change, diffs, exports, publish +
 * recompute, permissions and tenant isolation.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import {
  addPlanEvent, diffPlanVersions, exportPlan, readPlan, removePlanEvent, removePlanEventProperty, removePlanUserProperty,
  setPlanEventProperty, setPlanUserProperty, updatePlanEvent, type PlanActor,
} from "@/modules/implementation/editor";
import type { SectionKey } from "@/modules/implementation/questions";
import { approveVersion, editDraftEvent, generateDraft, implementationReport, listVersions, publishVersion, saveAnswers } from "@/modules/implementation/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
let me: PlanActor;
let v1: string;

const answers: Record<SectionKey, Record<string, unknown>> = {
  business: { "business.description": "Food delivery app: users order meals from restaurants and pay.", "business.model": "delivery", "business.customer_type": "b2c", "business.countries": ["SA"], "business.currencies": ["SAR"] },
  app: { "app.primary_action": "Order food", "app.has_signup": "true", "app.has_onboarding": "false", "app.features": ["search", "cart_checkout"], "app.multiple_user_types": "false" },
  monetization: { "monetization.streams": ["one_time"], "monetization.payment_confirmation": "backend", "monetization.has_refunds": "false" },
  journey: { "journey.description": "Users install, register, choose a restaurant, add meals to cart and pay." },
  attribution: { "attribution.channels": ["tiktok"], "attribution.main_channel": "tiktok", "attribution.existing_mmp": "none" },
  value: { "value.activation_event": "order_completed", "value.north_star_event": "order_completed" },
};

async function versionRows(versionId: string) {
  return withSystem(async (db) => ({
    events: (await db.query<{ event_name: string; required: boolean }>("select event_name, required from platform.tracking_events where plan_version_id = $1 order by event_name", [versionId])),
    props: Number((await db.one<{ n: string }>("select count(*) as n from platform.tracking_event_properties p join platform.tracking_events e on e.id = p.tracking_event_id where e.plan_version_id = $1", [versionId]))!.n),
    userProps: (await db.query<{ name: string }>("select name from platform.tracking_user_properties where plan_version_id = $1 order by name", [versionId])).map((r) => r.name),
    rules: Number((await db.one<{ n: string }>("select count(*) as n from platform.tracking_attribution_rules where plan_version_id = $1", [versionId]))!.n),
    status: (await db.one<{ status: string }>("select status from platform.tracking_plan_versions where id = $1", [versionId]))!.status,
  }));
}

beforeAll(async () => {
  t = await makeTenant("plan-edit");
  other = await makeTenant("plan-edit-other");
  me = { kind: "user", ctx: t.ctx };
  for (const section of Object.keys(answers) as SectionKey[]) expect((await saveAnswers(t.ctx, t.app.id, section, answers[section])).ok).toBe(true);
  v1 = (await generateDraft(t.ctx, t.app.id)).versionId;
  await approveVersion(t.ctx, t.app.id, v1);
  await publishVersion(t.ctx, t.app.id, v1);
});

describe("editing creates drafts", () => {
  let v2: string;
  let before: Awaited<ReturnType<typeof versionRows>>;

  it("copies the published version into a new draft on the first edit", async () => {
    before = await versionRows(v1);
    const r = await addPlanEvent(me, t.app.id, {
      event_name: "gift_card_redeemed", description: "A gift card was applied at checkout.", source: "backend", priority: "high", required: true,
      properties: [{ name: "gift_card_id", type: "string", required: true }, { name: "amount", type: "number" }, { name: "currency", type: "currency", required: true }],
    });
    expect(r).toMatchObject({ version: 2, draftCreated: true, warnings: [] });
    v2 = r.versionId;
    const after = await versionRows(v2);
    expect(after.status).toBe("draft");
    expect(after.events.map((e) => e.event_name)).toEqual([...before.events.map((e) => e.event_name), "gift_card_redeemed"].sort());
    expect(after.props).toBe(before.props + 3);
    expect(after.userProps).toEqual(before.userProps);
    expect(after.rules).toBe(before.rules);
    expect(before.rules).toBeGreaterThan(0);
    const versions = await listVersions(t.ctx, t.app.id);
    expect(versions.find((v) => v.id === v2)?.based_on_version_id).toBe(v1);
    const plan = await readPlan(me, t.app.id, v2);
    expect(plan!.events.find((e) => e.event_name === "gift_card_redeemed")).toMatchObject({ custom: true, source: "backend", platforms: ["backend"], display_name: "Gift Card Redeemed" });
  });

  it("further edits go to the same draft", async () => {
    const r = await updatePlanEvent(me, t.app.id, "search_performed", { required: true, priority: "high" });
    expect(r).toMatchObject({ versionId: v2, draftCreated: false });
    await setPlanEventProperty(me, t.app.id, "gift_card_redeemed", { name: "amount", type: "number", required: true, description: "Amount covered." });
    await setPlanEventProperty(me, t.app.id, "gift_card_redeemed", { name: "card_type", type: "string", allowed_values: ["physical", "digital"] });
    await removePlanEventProperty(me, t.app.id, "gift_card_redeemed", "currency");
    await setPlanUserProperty(me, t.app.id, { name: "loyalty_tier", type: "string", description: "Bronze / silver / gold.", source: "backend" });
    const removedUserProp = before.userProps[0];
    await removePlanUserProperty(me, t.app.id, removedUserProp);
    await removePlanEvent(me, t.app.id, "cart_viewed");
    expect((await listVersions(t.ctx, t.app.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it("never changes the published version", async () => {
    expect(await versionRows(v1)).toEqual(before);
    await expect(editDraftEvent(t.ctx, t.app.id, v1, "app_opened", { remove: true })).rejects.toBeInstanceOf(ConflictError);
  });

  it("starts from the library for standard names, and validates input", async () => {
    const r = await addPlanEvent(me, t.app.id, { event_name: "refund_completed" });
    const e = (await readPlan(me, t.app.id, r.versionId))!.events.find((x) => x.event_name === "refund_completed")!;
    expect(e.properties.map((p) => p.name)).toEqual(expect.arrayContaining(["transaction_id", "refund_amount", "currency"]));
    expect(e.source).toBe("backend");
    expect((await addPlanEvent(me, t.app.id, { event_name: "voucher_redeem" })).warnings[0]).toMatch(/past tense/);

    await expect(addPlanEvent(me, t.app.id, { event_name: "gift_card_redeemed" })).rejects.toBeInstanceOf(ConflictError);
    await expect(addPlanEvent(me, t.app.id, { event_name: "GiftCard" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addPlanEvent(me, t.app.id, { event_name: "user_identified" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addPlanEvent(me, t.app.id, { event_name: "x_done", properties: [{ name: "a", type: "money" }] })).rejects.toThrow(/type/);
    await expect(setPlanEventProperty(me, t.app.id, "gift_card_redeemed", { name: "user_id", type: "string" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setPlanUserProperty(me, t.app.id, { name: "cart_value", type: "number" })).rejects.toThrow(/event property/);
    await expect(updatePlanEvent(me, t.app.id, "nope_viewed", { required: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updatePlanEvent(me, t.app.id, "app_opened", {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("approving freezes the draft; the next edit copies the approved version", async () => {
    await approveVersion(t.ctx, t.app.id, v2);
    const frozen = await versionRows(v2);
    const r = await addPlanEvent(me, t.app.id, { event_name: "wishlist_shared" });
    expect(r).toMatchObject({ version: 3, draftCreated: true });
    expect(await versionRows(v2)).toEqual(frozen);
    const v3 = await versionRows(r.versionId);
    expect(v3.events.map((e) => e.event_name)).toEqual([...frozen.events.map((e) => e.event_name), "wishlist_shared"].sort());
    expect((await listVersions(t.ctx, t.app.id)).find((v) => v.id === r.versionId)?.based_on_version_id).toBe(v2);
  });
});

describe("diff and export", () => {
  it("diffs any two versions", async () => {
    const [v3, v2] = await listVersions(t.ctx, t.app.id);
    const d = await diffPlanVersions(t.ctx, t.app.id, v1, v2.id);
    expect(d.from.version).toBe(1);
    expect(d.to.version).toBe(2);
    expect(d.events.added.map((e) => e.event_name).sort()).toEqual(["gift_card_redeemed", "refund_completed", "voucher_redeem"]);
    expect(d.events.removed.map((e) => e.event_name)).toEqual(["cart_viewed"]);
    const search = d.events.changed.find((c) => c.event_name === "search_performed")!;
    expect(search.changes).toEqual(expect.arrayContaining([{ field: "required", from: false, to: true }, { field: "priority", from: expect.any(String), to: "high" }]));
    expect(d.user_properties.added.map((u) => u.name)).toEqual(["loyalty_tier"]);
    expect(d.user_properties.removed).toHaveLength(1);

    const d23 = await diffPlanVersions(t.ctx, t.app.id, v2.id, v3.id);
    expect(d23.count).toBe(1);
    expect(d23.events.added.map((e) => e.event_name)).toEqual(["wishlist_shared"]);
    expect((await diffPlanVersions(t.ctx, t.app.id, v3.id, v3.id)).count).toBe(0);
    await expect(diffPlanVersions(t.ctx, t.app.id, v1, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("exports JSON and CSV", async () => {
    const [, v2] = await listVersions(t.ctx, t.app.id);
    const json = await exportPlan(t.ctx, t.app.id, v2.id, "json");
    expect(json.contentType).toMatch(/application\/json/);
    expect(json.filename).toBe(`${t.app.slug}-tracking-plan-v2.json`);
    const doc = JSON.parse(json.body);
    expect(doc).toMatchObject({ format: "leanapp.tracking_plan/v1", version: 2, status: "approved", app: { id: t.app.id } });
    const gift = doc.events.find((e: { event_name: string }) => e.event_name === "gift_card_redeemed");
    expect(gift.properties.map((p: { name: string }) => p.name).sort()).toEqual(["amount", "card_type", "gift_card_id"]);
    expect(gift.properties.find((p: { name: string }) => p.name === "card_type").allowed_values).toEqual(["physical", "digital"]);

    const csv = await exportPlan(t.ctx, t.app.id, v2.id, "csv");
    expect(csv.contentType).toMatch(/text\/csv/);
    const lines = csv.body.trimEnd().split("\r\n");
    expect(lines[0]).toMatch(/^kind,event_name,display_name,/);
    expect(lines.filter((l) => l.startsWith("event,"))).toHaveLength(doc.events.length);
    expect(lines).toContain("event_property,gift_card_redeemed,,,,,,,card_type,string,false,physical|digital,,,");
    expect(lines.some((l) => l.startsWith("user_property,") && l.includes(",loyalty_tier,"))).toBe(true);
  });
});

describe("publish", () => {
  it("publishing an edited version validates events against it", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    await ingest(sdk, { type: "track", event_name: "wishlist_shared", event_id: crypto.randomUUID(), anonymous_id: "a1", properties: {} }, { mode: "single" });
    await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
    let report = await implementationReport(t.ctx, t.app.id, t.dev.id);
    expect(report.unplanned.map((u) => u.event_name)).toContain("wishlist_shared");

    const [v3] = await listVersions(t.ctx, t.app.id);
    await approveVersion(t.ctx, t.app.id, v3.id);
    await publishVersion(t.ctx, t.app.id, v3.id);
    report = await implementationReport(t.ctx, t.app.id, t.dev.id);
    expect(report.versionNumber).toBe(3);
    expect(report.unplanned.map((u) => u.event_name)).not.toContain("wishlist_shared");
    expect(report.events.find((e) => e.event_name === "wishlist_shared")).toMatchObject({ status: "validated", valid_count: 1 });
    expect((await readPlan(me, t.app.id, "published"))!.version.version).toBe(3);
  });

  it("an app without a plan starts an empty hand-written draft", async () => {
    const r = await addPlanEvent({ kind: "user", ctx: other.ctx }, other.app.id, { event_name: "lesson_completed" });
    expect(r).toMatchObject({ version: 1, draftCreated: true });
    const plan = await readPlan({ kind: "user", ctx: other.ctx }, other.app.id, r.versionId);
    expect(plan!.version.generator).toBe("manual");
    expect(plan!.events.map((e) => e.event_name)).toEqual(["lesson_completed"]);
  });
});

describe("permissions and isolation", () => {
  it("needs implementation.edit to edit and implementation.read to diff", async () => {
    const analyst = { kind: "user" as const, ctx: { ...t.ctx, role: "analyst" as const } };
    await expect(addPlanEvent(analyst, t.app.id, { event_name: "thing_happened" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removePlanEvent(analyst, t.app.id, "app_opened")).rejects.toBeInstanceOf(ForbiddenError);
    const [a, b] = await listVersions(t.ctx, t.app.id);
    expect((await diffPlanVersions(analyst.ctx, t.app.id, b.id, a.id)).to.version).toBe(a.version);
  });

  it("another organization can't read, diff, export or edit the plan", async () => {
    const intruder = { kind: "user" as const, ctx: other.ctx };
    await expect(addPlanEvent(intruder, t.app.id, { event_name: "thing_happened" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(readPlan(intruder, t.app.id, v1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(exportPlan(other.ctx, t.app.id, v1, "json")).rejects.toBeInstanceOf(NotFoundError);
    // Even with its own app id, a version id of another tenant is not found.
    await expect(exportPlan(other.ctx, other.app.id, v1, "csv")).rejects.toBeInstanceOf(NotFoundError);
    await expect(diffPlanVersions(other.ctx, other.app.id, v1, v1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a key only reaches its own app", async () => {
    const key: PlanActor = { kind: "api_key", organizationId: other.org.id, appId: other.app.id, keyId: crypto.randomUUID() };
    await expect(addPlanEvent(key, t.app.id, { event_name: "thing_happened" })).rejects.toBeInstanceOf(NotFoundError);
    // Forged org id with the right app id: RLS still hides the other tenant's plan.
    await expect(addPlanEvent({ kind: "api_key", organizationId: other.org.id, appId: t.app.id, keyId: crypto.randomUUID() }, t.app.id, { event_name: "thing_happened" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
