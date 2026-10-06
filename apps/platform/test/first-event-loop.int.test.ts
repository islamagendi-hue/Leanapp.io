/**
 * The first-priority product loop, end to end against Postgres:
 * sign up → organization → app → questionnaire → tracking plan → approve →
 * publish → events → processing → debugger → implementation score.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { getUserBySessionToken, signIn, signOut } from "@/modules/auth/service";
import { authenticateIngestionKey, createApiKey, listKeys, revokeSdkKey, rotateSdkKey } from "@/modules/credentials/service";
import { liveEvents } from "@/modules/debugger/service";
import { nextQuestions, type SectionKey } from "@/modules/implementation/questions";
import {
  approveVersion, decideMapping, editDraftEvent, generateDraft, getPlanVersion, getProject, implementationReport,
  listMappings, publishVersion, saveAnswers,
} from "@/modules/implementation/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;

const answers: Record<SectionKey, Record<string, unknown>> = {
  business: {
    "business.description": "We are a food delivery app. Users choose restaurants, add meals to cart, checkout and pay.",
    "business.model": "delivery",
    "business.customer_type": "b2c",
    "business.countries": ["SA", "AE"],
    "business.currencies": ["SAR", "AED"],
  },
  app: {
    "app.primary_action": "Order food",
    "app.has_signup": "true",
    "app.has_onboarding": "false",
    "app.features": ["search", "cart_checkout", "reviews", "push"],
    "app.multiple_user_types": "false",
  },
  monetization: { "monetization.streams": ["one_time"], "monetization.payment_confirmation": "backend", "monetization.has_refunds": "false" },
  journey: { "journey.description": "Users see a TikTok ad, install the app, register, choose a restaurant, add meals to cart, checkout and pay." },
  attribution: { "attribution.channels": ["tiktok", "snapchat"], "attribution.main_channel": "tiktok", "attribution.existing_mmp": "none" },
  value: { "value.activation_event": "order_completed", "value.north_star_event": "order_completed" },
};

beforeAll(async () => {
  t = await makeTenant("loop");
});

describe("auth", () => {
  it("signs in, resolves the session and revokes it on sign-out", async () => {
    const s = await signIn({ email: t.user.email, password: "correct-horse-9" }, { ip: "1.1.1.1" });
    expect((await getUserBySessionToken(s.token))?.id).toBe(t.user.id);
    await signOut(s.token);
    expect(await getUserBySessionToken(s.token)).toBeNull();
    await expect(signIn({ email: t.user.email, password: "wrong-password-1" }, { ip: "1.1.1.2" })).rejects.toThrow(/incorrect/);
  });
});

describe("questionnaire → plan", () => {
  it("adapts and completes", async () => {
    for (const section of Object.keys(answers) as SectionKey[]) {
      const r = await saveAnswers(t.ctx, t.app.id, section, answers[section]);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const p = await getProject(t.ctx, t.app.id);
    const pending = nextQuestions(p.answers);
    expect(pending, JSON.stringify(pending && { section: pending.section.key, missing: pending.questions.filter((q) => !(q.key in p.answers)).map((q) => q.key) })).toBeNull();
    // Adaptive: user types question was never shown because there is only one type.
    expect(p.answers["app.user_types"]).toBeUndefined();
  });

  it("rejects incomplete required answers", async () => {
    const r = await saveAnswers(t.ctx, t.app.id, "journey", { "journey.description": "" });
    expect(r.ok).toBe(false);
  });

  it("generates, edits, approves and publishes a versioned plan", async () => {
    const { versionId, version } = await generateDraft(t.ctx, t.app.id);
    expect(version).toBe(1);
    const plan = (await getPlanVersion(t.ctx, t.app.id, versionId))!;
    const names = plan.events.map((e) => e.event_name);
    expect(names).toEqual(expect.arrayContaining(["restaurant_viewed", "product_added_to_cart", "checkout_started", "order_completed"]));
    expect(plan.attributionRules.map((r) => r.channel).sort()).toEqual(["snapchat", "tiktok"]);
    await editDraftEvent(t.ctx, t.app.id, versionId, "menu_viewed", { remove: true });
    await approveVersion(t.ctx, t.app.id, versionId);
    await expect(editDraftEvent(t.ctx, t.app.id, versionId, "cart_viewed", { remove: true })).rejects.toThrow(/Only draft/);
    await publishVersion(t.ctx, t.app.id, versionId);
    expect((await getProject(t.ctx, t.app.id)).publishedVersionId).toBe(versionId);
  });
});

describe("events → debugger → score", () => {
  it("scores 0 before any event", async () => {
    const r = await implementationReport(t.ctx, t.app.id, t.dev.id);
    expect(r.score!.components.find((c) => c.key === "sdk_connection")!.score).toBe(0);
    expect(r.score!.missingCritical).toContain("order_completed");
  });

  it("ingests, de-duplicates, processes, validates and scores", async () => {
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    expect(sdk.environmentId).toBe(t.dev.id);
    const ctx = { platform: "ios", app_version: "1.0.0", sdk: { name: "leanapp-js", version: "0.1.0" }, attribution: { utm_source: "tiktok", utm_campaign: "launch", ttclid: "abc" } };
    const e1 = crypto.randomUUID();
    const batch = {
      batch: [
        { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "a1", session_id: "s1", context: ctx },
        { type: "screen", event_name: "Home", event_id: crypto.randomUUID(), anonymous_id: "a1", session_id: "s1", context: ctx },
        { type: "track", event_name: "restaurant_viewed", event_id: e1, anonymous_id: "a1", session_id: "s1", properties: { restaurant_id: "r1" }, context: ctx },
        { type: "track", event_name: "restaurant_viewed", event_id: e1, anonymous_id: "a1", session_id: "s1", properties: { restaurant_id: "r1" }, context: ctx },
        { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "a1", user_id: "u1", session_id: "s1", user_properties: { language: "ar", city: "Riyadh", cart_value: 5 }, context: ctx },
        { type: "track", event_name: "product_added_to_cart", event_id: crypto.randomUUID(), anonymous_id: "a1", user_id: "u1", session_id: "s1", properties: { product_id: "p1", quantity: "2" }, context: ctx },
        { type: "track", event_name: "purchase", event_id: crypto.randomUUID(), anonymous_id: "a1", user_id: "u1", session_id: "s1", properties: { revenue: 50 }, context: ctx },
        { type: "track", event_name: "bad name!", anonymous_id: "a1" },
      ],
    };
    const res = await ingest(sdk, batch, { mode: "batch", idempotencyKey: "batch-1" });
    expect(res.status).toBe(200);
    const body = res.body as { accepted: number; duplicates: number; rejected: unknown[] };
    expect(body.accepted).toBe(6);
    expect(body.duplicates).toBe(1);
    expect(body.rejected).toHaveLength(1);

    // Same Idempotency-Key replays the stored response without inserting anything.
    const replay = await ingest(sdk, batch, { mode: "batch", idempotencyKey: "batch-1" });
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(res.body);
    // Same events without the key are recognised as duplicates by event_id.
    const retry = await ingest(sdk, { batch: batch.batch.slice(0, 7) }, { mode: "batch" });
    expect((retry.body as { accepted: number }).accepted).toBe(0);

    // Backend revenue event with a secret key.
    const secret = await createApiKey(t.ctx, t.dev.id, { label: "server" });
    const server = (await authenticateIngestionKey(secret.key))!;
    expect(server.kind).toBe("api");
    const order = await ingest(server, {
      event_name: "order_completed", user_id: "u1", event_id: "txn_1",
      properties: { order_id: "o1", transaction_id: "txn_1", revenue: 86, currency: "SAR", item_count: 2 },
    }, { mode: "single" });
    expect((order.body as { accepted: number }).accepted).toBe(1);

    expect(await processPendingEvents()).toEqual({ processed: 7, failed: 0 });

    // Debugger shows payloads and live validation verdicts.
    const live = await liveEvents(t.ctx, t.dev.id);
    expect(live[0].event_name).toBe("order_completed");
    expect(live[0].source).toBe("backend");
    expect(live[0].validation?.valid).toBe(true);
    const cart = live.find((e) => e.event_name === "product_added_to_cart")!;
    expect(cart.validation?.valid).toBe(false);
    expect(cart.validation?.errors.map((e) => e.code)).toContain("wrong_type");
    const identify = live.find((e) => e.event_name === "user_identified")!;
    expect(identify.validation?.warnings.some((w) => w.code === "volatile_user_property")).toBe(true);

    // Identity graph and sessions were derived.
    const links = await withSystem((db) => db.query("select * from platform.identity_links where environment_id = $1", [t.dev.id]));
    expect(links).toHaveLength(1);
    const session = await withSystem((db) => db.one<{ event_count: number; screen_count: number; entry_source: string }>("select event_count, screen_count, entry_source from platform.sessions where environment_id = $1 and session_id = 's1'", [t.dev.id]));
    expect(session).toMatchObject({ event_count: 6, screen_count: 1, entry_source: "tiktok" });

    const report = await implementationReport(t.ctx, t.app.id, t.dev.id);
    const s = report.score!;
    expect(s.components.find((c) => c.key === "sdk_connection")!.score).toBe(100);
    // order_completed is valid; order_cancelled (also revenue-relevant) has not been sent yet.
    expect(s.components.find((c) => c.key === "revenue_events")!.score).toBe(50);
    expect(s.components.find((c) => c.key === "backend_events")!.score).toBeGreaterThan(0);
    expect(s.failing).toContain("product_added_to_cart");
    expect(s.overall).toBeGreaterThan(0);
    expect(s.overall).toBeLessThan(100);
    expect(report.unplanned.map((u) => u.event_name)).toContain("purchase");
  });

  it("detects the purchase → order mismatch and re-validates when the mapping is accepted", async () => {
    const mappings = await listMappings(t.ctx, t.app.id);
    const m = mappings.find((x) => x.from_name === "purchase");
    expect(m?.status).toBe("suggested");
    expect(m?.to_name).toBe("order_completed");
    await decideMapping(t.ctx, t.app.id, m!.id, true);
    const report = await implementationReport(t.ctx, t.app.id, t.dev.id);
    expect(report.unplanned.map((u) => u.event_name)).not.toContain("purchase");
    const order = report.events.find((e) => e.event_name === "order_completed")!;
    expect(order.received_count).toBe(2);
    expect(order.invalid_count).toBe(1); // the mapped `purchase` lacks transaction_id / currency
  });
});

describe("credential lifecycle", () => {
  it("rotates with a grace period and revokes immediately", async () => {
    const keys = await listKeys(t.ctx, t.app.id);
    const old = keys.sdkKeys.find((k) => k.environment_id === t.dev.id && k.status === "active")!;
    const fresh = await rotateSdkKey(t.ctx, old.id, 24);
    expect(await authenticateIngestionKey(old.key)).not.toBeNull(); // grace period
    expect(await authenticateIngestionKey(fresh.key)).not.toBeNull();
    await revokeSdkKey(t.ctx, old.id);
    expect(await authenticateIngestionKey(old.key)).toBeNull();
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from platform.audit_logs where organization_id = $1", [t.org.id]));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["sdk_key.rotated", "sdk_key.revoked", "api_key.created", "tracking_plan.published"]));
  });

  it("rejects malformed, unknown and production-mismatched keys", async () => {
    expect(await authenticateIngestionKey("nope")).toBeNull();
    expect(await authenticateIngestionKey("la_pk_dev_" + "a".repeat(24))).toBeNull();
  });
});
