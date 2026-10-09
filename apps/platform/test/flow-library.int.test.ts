/**
 * Flows library: applying a template creates a draft flow (never active, never
 * sending), with the events the person mapped, under the same permission as
 * creating a flow.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { AR } from "@/i18n/ar";
import { makeT } from "@/i18n/translate";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { FLOW_TEMPLATE_IDS } from "@/modules/automation/library";
import { createAutomationFromTemplate, getAutomation, listAutomations } from "@/modules/automation/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;

beforeAll(async () => {
  t = await makeTenant("flowlib");
  other = await makeTenant("flowlib-other");
});

describe("flows library", () => {
  it("creates a draft from a template with the mapped events, and nothing runs", async () => {
    const { id } = await createAutomationFromTemplate(t.ctx, t.dev.id, "abandoned_cart", { events: { cart: "add_to_bag", purchase: "order_completed" } });
    const { automation: a, versions, runs } = await getAutomation(t.ctx, id);
    expect(a).toMatchObject({ status: "draft", kind: "automation", version: 1, name: "Abandoned cart", activated_at: null });
    expect(a.definition.trigger).toEqual({ type: "event", event: "add_to_bag" });
    expect(a.definition.goal).toEqual({ event: "order_completed", withinDays: 3, stopOnConversion: true });
    expect(a.definition.exitEvent).toBe("checkout_started");
    expect(a.definition.steps.map((s) => s.type)).toEqual(["delay", "push", "delay", "email"]);
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(runs).toEqual([]);

    // The trigger event arriving doesn't start anything while the flow is a draft.
    const sdk = (await authenticateIngestionKey(t.sdkKey))!;
    await ingest(sdk, { batch: [{ type: "track", event_id: crypto.randomUUID(), event_name: "add_to_bag", user_id: "u1" }] }, { mode: "batch" });
    await processPendingEvents({ environmentId: t.dev.id, limit: 100 });
    await enqueueTriggers();
    await stepRuns();
    expect((await getAutomation(t.ctx, id)).runs).toEqual([]);

    const audit = await withSystem((db) => db.query<{ metadata: { template?: string } }>("select metadata from platform.audit_logs where target_id = $1 and action = 'automation.created'", [id]));
    expect(audit[0]?.metadata.template).toBe("abandoned_cart");
  });

  it("applies every template as a draft, with copy in the reader's language", async () => {
    for (const tpl of FLOW_TEMPLATE_IDS) await createAutomationFromTemplate(t.ctx, t.dev.id, tpl, {}, { t: makeT(AR) });
    const flows = await listAutomations(t.ctx, t.dev.id);
    expect(flows.filter((f) => f.name !== "Abandoned cart")).toHaveLength(FLOW_TEMPLATE_IDS.length);
    expect(flows.every((f) => f.status === "draft")).toBe(true);
    expect(flows.map((f) => f.name)).toContain(AR["Welcome series"]);
  });

  it("rejects unknown templates and invalid mappings", async () => {
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "nope")).rejects.toThrow(/Choose a flow from the library/);
    // Goal and trigger can't be the same event.
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "checkout_recovery", { events: { checkout: "x", purchase: "x" } })).rejects.toThrow(/different event/);
  });

  it("needs the permission to create flows, in the member's own environments", async () => {
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "viewer" }, t.dev.id, "welcome_series")).rejects.toThrow(/permission/);
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "analyst" }, t.dev.id, "welcome_series")).rejects.toThrow(/permission/);
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "marketer" }, t.dev.id, "welcome_series")).resolves.toHaveProperty("id");
    await expect(createAutomationFromTemplate(other.ctx, t.dev.id, "welcome_series")).rejects.toThrow();
  });
});
