/**
 * Experiments (A/B tests): lifecycle and audit, permissions, the public
 * assignment API (sticky, targeted, per environment and tenant), exposures
 * sent as events, and the results computation, against real Postgres + RLS.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as assignmentsRoute from "@/app/v1/experiments/assignments/route";
import { withSystem, withTenant } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { activateAudience, createAudience, recomputeDueAudiences } from "@/modules/audiences/service";
import { listAuditLogs } from "@/modules/audit/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { NEW_FORM, type ExperimentForm } from "@/modules/experiments/definition";
import { createExperiment, experimentResults, getExperiment, listExperiments, startExperiment, stopExperiment, updateExperiment } from "@/modules/experiments/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import type { TenantContext } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;

const form = (f: ExperimentForm = {}): ExperimentForm => ({ ...NEW_FORM, name: "Price on button", key: "checkout_button", goalEvent: "order_completed", ...f });
const as = (role: TenantContext["role"]) => ({ ...t.ctx, role });

type Assignments = { assignments: { experiment: string; experiment_id: string; variant: string | null }[] };
async function assignments(key: string | null, query: string, method: "GET" | "POST" = "GET"): Promise<{ status: number; body: Assignments & { error?: string } }> {
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const res = method === "GET"
    ? await assignmentsRoute.GET(new Request(`http://localhost/v1/experiments/assignments?${query}`, { headers }))
    : await assignmentsRoute.POST(new Request("http://localhost/v1/experiments/assignments", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: query }));
  return { status: res.status, body: await res.json() };
}
const variantOf = (body: Assignments, key: string) => body.assignments.find((a) => a.experiment === key)?.variant;

async function send(tenant: T, events: Record<string, unknown>[]) {
  const sdk = (await authenticateIngestionKey(tenant.sdkKey))!;
  for (let i = 0; i < events.length; i += 500) {
    const r = await ingest(sdk, { batch: events.slice(i, i + 500).map((e) => ({ type: "track", event_id: crypto.randomUUID(), ...e })) }, { mode: "batch" });
    expect(r.status).toBe(200);
    expect((r.body as { rejected: unknown[] }).rejected).toEqual([]);
  }
  await processPendingEvents({ environmentId: tenant.dev.id, limit: 20_000 });
}

const ago = (days: number, plusHours = 0) => new Date(Date.now() - days * 86_400_000 + plusHours * 3_600_000).toISOString();
const exposure = (id: string, key: string, variant: string, user: string, at: string) =>
  ({ event_name: "experiment_exposure", user_id: user, timestamp: at, properties: { experiment: key, experiment_id: id, variant } });

beforeAll(async () => {
  t = await makeTenant("exp");
  other = await makeTenant("exp-other");
});

describe("experiments: lifecycle, validation and audit", () => {
  let id: string;

  it("saves a draft, edits it, starts and stops it, and audits each step", async () => {
    id = (await createExperiment(t.ctx, t.dev.id, form())).id;
    let x = await getExperiment(t.ctx, id);
    expect(x).toMatchObject({ status: "draft", key: "checkout_button", trafficPercent: 100, startedAt: null });
    expect(x.salt).toMatch(/^[0-9a-f]{32}$/);
    await updateExperiment(t.ctx, id, form({ name: "Price on the button", variantKey2: "badge", variantWeight2: "20" }));
    x = await getExperiment(t.ctx, id);
    expect(x.variants.map((v) => v.key)).toEqual(["control", "treatment", "badge"]);
    await expect(createExperiment(t.ctx, t.dev.id, form())).rejects.toBeInstanceOf(ConflictError); // same key in the environment
    const prod = t.environments.find((e) => e.type === "production")!;
    expect((await createExperiment(t.ctx, prod.id, form())).id).toBeTruthy(); // fine in another environment

    await startExperiment(t.ctx, id);
    x = await getExperiment(t.ctx, id);
    expect(x.status).toBe("running");
    expect(x.startedAt).toBeInstanceOf(Date);
    await expect(updateExperiment(t.ctx, id, form())).rejects.toBeInstanceOf(ConflictError);
    await expect(startExperiment(t.ctx, id)).rejects.toBeInstanceOf(ConflictError);
    await stopExperiment(t.ctx, id);
    x = await getExperiment(t.ctx, id);
    expect(x.status).toBe("stopped");
    await expect(startExperiment(t.ctx, id)).rejects.toThrow(/can't be started again/);
    await expect(stopExperiment(t.ctx, id)).rejects.toBeInstanceOf(ConflictError);

    const actions = (await listAuditLogs(t.ctx, { area: "experiment" })).rows.filter((r) => r.target_id === id).map((r) => r.action);
    expect(actions).toEqual(["experiment.stopped", "experiment.started", "experiment.updated", "experiment.created"]);
    expect((await listExperiments(t.ctx, t.dev.id)).map((e) => e.id)).toContain(id);
  });

  it("validates the form and the audience", async () => {
    await expect(createExperiment(t.ctx, t.dev.id, form({ key: "x", name: "Bad" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createExperiment(t.ctx, t.dev.id, form({ key: "other_key", audienceId: crypto.randomUUID() }))).rejects.toThrow(/audience doesn't exist/);
    const draftAudience = (await createAudience(t.ctx, t.dev.id, { name: "Draft people", definition: { type: "user_property", property: "vip", op: "eq", value: true } })).id;
    const e = (await createExperiment(t.ctx, t.dev.id, form({ key: "draft_audience", audienceId: draftAudience }))).id;
    await expect(startExperiment(t.ctx, e)).rejects.toThrow(/Activate the audience "Draft people" first/);
  });

  it("needs automations.read to see and automations.manage to change", async () => {
    await expect(listExperiments(as("analyst"), t.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getExperiment(as("viewer"), id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(experimentResults(as("developer"), id, "UTC")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExperiment(as("analyst"), t.dev.id, form({ key: "analyst_try" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listExperiments(as("marketer"), t.dev.id)).length).toBeGreaterThan(0);
    const mine = (await createExperiment(as("marketer"), t.dev.id, form({ key: "marketer_try" }))).id;
    await startExperiment(as("marketer"), mine);
    await stopExperiment(as("marketer"), mine);
  });

  it("keeps experiments inside their organization", async () => {
    await expect(getExperiment(other.ctx, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(startExperiment(other.ctx, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(experimentResults(other.ctx, id, "UTC")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createExperiment(other.ctx, t.dev.id, form({ key: "sneaky" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(await listExperiments(other.ctx, t.dev.id)).toEqual([]);
    const rows = await withTenant({ organizationId: other.org.id, userId: other.user.id }, (db) => db.query("select id from platform.experiments"));
    expect(rows).toEqual([]);
  });
});

describe("assignment API", () => {
  let running: string;
  let targeted: string;

  beforeAll(async () => {
    running = (await createExperiment(t.ctx, t.dev.id, form({ key: "onboarding", goalEvent: "signup_completed" }))).id;
    await startExperiment(t.ctx, running);
    // An audience of VIPs for a targeted experiment.
    await send(t, [
      { type: "identify", user_id: "vip-1", user_properties: { vip: true } },
      { type: "identify", anonymous_id: "device-9", user_id: "u-9", user_properties: { vip: false } },
    ]);
    const audience = (await createAudience(t.ctx, t.dev.id, { name: "VIP", definition: { type: "user_property", property: "vip", op: "eq", value: true } })).id;
    await activateAudience(t.ctx, audience);
    await recomputeDueAudiences();
    targeted = (await createExperiment(t.ctx, t.dev.id, form({ key: "vip_offer", audienceId: audience }))).id;
    await startExperiment(t.ctx, targeted);
  });

  it("returns every running experiment, the same variant every time, and nothing for drafts or stopped ones", async () => {
    const first = await assignments(t.sdkKey, "user_id=u-1");
    expect(first.status).toBe(200);
    expect(first.body.assignments.map((a) => a.experiment)).toEqual(["onboarding", "vip_offer"]); // not checkout_button (stopped), not drafts
    expect(["control", "treatment"]).toContain(variantOf(first.body, "onboarding"));
    for (let i = 0; i < 3; i++) expect(variantOf((await assignments(t.sdkKey, "user_id=u-1")).body, "onboarding")).toBe(variantOf(first.body, "onboarding"));
    const post = await assignments(t.sdkKey, JSON.stringify({ user_id: "u-1" }), "POST");
    expect(post.body).toEqual(first.body);
  });

  it("splits people across variants", async () => {
    const seen = new Set<string | null | undefined>();
    for (let i = 0; i < 40; i++) seen.add(variantOf((await assignments(t.sdkKey, `user_id=split-${i}`)).body, "onboarding"));
    expect(seen).toEqual(new Set(["control", "treatment"]));
  });

  it("treats an install linked to one user as that user", async () => {
    const byUser = variantOf((await assignments(t.sdkKey, "user_id=u-9")).body, "onboarding");
    for (let i = 0; i < 20; i++) {
      // device-9 is linked to u-9 only, so it gets u-9's variant whichever experiment salt applies.
      expect(variantOf((await assignments(t.sdkKey, "anonymous_id=device-9")).body, "onboarding")).toBe(byUser);
    }
  });

  it("gives targeted experiments only to the audience", async () => {
    expect(variantOf((await assignments(t.sdkKey, "user_id=vip-1")).body, "vip_offer")).not.toBeNull();
    expect(variantOf((await assignments(t.sdkKey, "user_id=u-1")).body, "vip_offer")).toBeNull();
  });

  it("answers within the key's environment and organization only, and refuses bad requests", async () => {
    expect((await assignments(other.sdkKey, "user_id=u-1")).body.assignments).toEqual([]);
    const prodKey = (await withSystem((db) => db.one<{ key: string }>("select key from platform.sdk_keys where environment_id = $1", [t.environments.find((e) => e.type === "production")!.id])))!.key;
    expect((await assignments(prodKey, "user_id=u-1")).body.assignments.map((a) => a.experiment)).not.toContain("onboarding");
    expect((await assignments(null, "user_id=u-1")).status).toBe(401);
    expect((await assignments("la_pk_dev_notarealkey00000000000000", "user_id=u-1")).status).toBe(401);
    const none = await assignments(t.sdkKey, "");
    expect(none.status).toBe(422);
    expect((await assignmentsRoute.OPTIONS()).status).toBe(204);
    const logs = await withSystem((db) => db.query<{ route: string }>("select route from platform.api_request_logs where environment_id = $1 and route like '%experiments%'", [t.dev.id]));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("results", () => {
  let id: string;
  const people = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  beforeAll(async () => {
    id = (await createExperiment(t.ctx, t.dev.id, form({ key: "pricing", goalEvent: "order_completed", goalWindow: "7", secondaryKind: "revenue" }))).id;
    await startExperiment(t.ctx, id);
    await withSystem((db) => db.query("update platform.experiments set started_at = now() - interval '20 days' where id = $1", [id]));
    const control = people("c", 200);
    const treatment = people("t", 200);
    const events: Record<string, unknown>[] = [];
    control.forEach((u, i) => {
      events.push(exposure(id, "pricing", "control", u, ago(15)));
      if (i < 20) events.push({ event_name: "order_completed", user_id: u, timestamp: ago(15, 2), properties: { order_id: `o-${u}`, revenue: 10, currency: "SAR" } });
    });
    treatment.forEach((u, i) => {
      events.push(exposure(id, "pricing", "treatment", u, ago(15)));
      if (i < 40) events.push({ event_name: "order_completed", user_id: u, timestamp: ago(15, 2), properties: { order_id: `o-${u}`, revenue: 10, currency: "SAR" } });
    });
    // Not conversions: after the window, before the exposure, or for another experiment.
    events.push({ event_name: "order_completed", user_id: "c-100", timestamp: ago(5), properties: { order_id: "late", revenue: 99, currency: "SAR" } });
    events.push({ event_name: "order_completed", user_id: "c-101", timestamp: ago(16), properties: { order_id: "early", revenue: 99, currency: "SAR" } });
    events.push(exposure(crypto.randomUUID(), "pricing", "treatment", "c-102", ago(14)));
    // c-0 later sees the treatment too: still counted once, in control.
    events.push(exposure(id, "pricing", "treatment", "c-0", ago(14)));
    // An exposure before the start doesn't count.
    events.push(exposure(id, "pricing", "control", "too-early", ago(25)));
    await send(t, events);
  });

  it("counts exposed people, conversions in the window, the test and revenue per person", async () => {
    const r = await experimentResults(t.ctx, id, "Asia/Riyadh");
    expect(r.totalExposed).toBe(400);
    const [c, v] = r.variants;
    expect([c.exposed, c.goal.conversions, v.exposed, v.goal.conversions]).toEqual([200, 20, 200, 40]);
    expect(c.goal.comparison).toBeNull();
    expect(v.goal.rate).toBeCloseTo(0.2, 10);
    expect(v.goal.enough).toBe(true);
    // 10% vs 20% of 200: z = 0.1 / sqrt(0.15 · 0.85 · 2/200) = 2.8006, p = 0.0051.
    expect(v.goal.comparison!.z).toBeCloseTo(2.8006, 3);
    expect(v.goal.comparison!.pValue).toBeCloseTo(0.0051, 3);
    expect(v.goal.comparison!.uplift).toBeCloseTo(1, 10);
    expect(v.goal.significant).toBe(true);
    expect(r.enough).toBe(true);
    expect(r.switched).toBe(1);
    expect(r.srm.mismatch).toBe(false);
    expect(r.currencies).toEqual(["SAR"]);
    expect(c.revenue).toEqual([{ currency: "SAR", net: 200, perPerson: 1 }]);
    expect(v.revenue).toEqual([{ currency: "SAR", net: 400, perPerson: 2 }]);
    expect(r.stillInWindow).toBe(0);
    // Days in the app's timezone from the start (20 days ago) to today; exposed people so far per variant.
    expect(r.days).toHaveLength(21);
    expect(r.cumulative.map((s) => s.counts.at(-1))).toEqual([200, 200]);
  });

  it("applies the goal's property filter", async () => {
    const filtered = (await createExperiment(t.ctx, t.dev.id, form({ key: "pricing_filtered", goalFilterName: "revenue", goalFilterOp: "gt", goalFilterValue: "50" }))).id;
    await startExperiment(t.ctx, filtered);
    await withSystem((db) => db.query("update platform.experiments set started_at = now() - interval '3 days' where id = $1", [filtered]));
    await send(t, [
      exposure(filtered, "pricing_filtered", "control", "f-1", ago(2)),
      exposure(filtered, "pricing_filtered", "treatment", "f-2", ago(2)),
      { event_name: "order_completed", user_id: "f-1", timestamp: ago(1), properties: { order_id: "f1", revenue: 20, currency: "SAR" } },
      { event_name: "order_completed", user_id: "f-2", timestamp: ago(1), properties: { order_id: "f2", revenue: 80, currency: "SAR" } },
    ]);
    const r = await experimentResults(t.ctx, filtered, "UTC");
    expect(r.variants.map((x) => [x.exposed, x.goal.conversions])).toEqual([[1, 0], [1, 1]]);
    expect(r.enough).toBe(false); // not enough data yet
    expect(r.variants[1].goal.significant).toBeNull();
    expect(r.stillInWindow).toBe(2);
  });

  it("flags a sample ratio mismatch", async () => {
    const srm = (await createExperiment(t.ctx, t.dev.id, form({ key: "lopsided" }))).id;
    await startExperiment(t.ctx, srm);
    await withSystem((db) => db.query("update platform.experiments set started_at = now() - interval '3 days' where id = $1", [srm]));
    await send(t, [
      ...people("l-c", 150).map((u) => exposure(srm, "lopsided", "control", u, ago(2))),
      ...people("l-t", 50).map((u) => exposure(srm, "lopsided", "treatment", u, ago(2))),
    ]);
    const r = await experimentResults(t.ctx, srm, "UTC");
    expect(r.variants.map((x) => x.exposed)).toEqual([150, 50]);
    expect(r.srm.mismatch).toBe(true);
    expect(r.srm.pValue).toBeLessThan(0.001);
  });

  it("shows nothing for a draft", async () => {
    const draft = (await createExperiment(t.ctx, t.dev.id, form({ key: "not_started" }))).id;
    const r = await experimentResults(t.ctx, draft, "UTC");
    expect(r.totalExposed).toBe(0);
    expect(r.days).toEqual([]);
  });
});
