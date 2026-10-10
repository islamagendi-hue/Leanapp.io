/**
 * Flows library: applying a template creates a valid draft flow (never
 * active, never sending), with the events the person mapped, under the same
 * permission as creating a flow. Audience-started templates create their
 * audience as a draft in the same transaction; WhatsApp templates need an
 * approved, synced template.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { AR } from "@/i18n/ar";
import { makeT } from "@/i18n/translate";
import { activateAudience, getAudience } from "@/modules/audiences/service";
import { parseAutomation } from "@/modules/automation/definition";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { FLOW_TEMPLATE_IDS, getFlowTemplate } from "@/modules/automation/library";
import { activateAutomation, createAutomationFromTemplate, getAutomation, listAutomations } from "@/modules/automation/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { configureWhatsApp } from "@/modules/messaging/integrations";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

process.env.INTEGRATIONS_ENCRYPTION_KEY ??= "c".repeat(64);

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let other: T;
const whatsapp = { template: "cart_reminder", language: "ar", bodyParams: ["{{user.first_name}}"] };

/** A WhatsApp integration with one approved template that has one body variable. */
async function syncedWhatsAppTemplate(tenant: T) {
  const { id } = await configureWhatsApp(tenant.ctx, tenant.dev.id, { phoneNumberId: "1110001", wabaId: "2220002", accessToken: "x".repeat(30), appSecret: "0123456789abcdef0123456789abcdef" });
  await withSystem((db) => db.query(
    `insert into platform.whatsapp_templates (organization_id, app_id, environment_id, integration_id, name, language, status, body_params, header_params)
     values ($1, $2, $3, $4, 'cart_reminder', 'ar', 'APPROVED', 1, 0)`,
    [tenant.org.id, tenant.app.id, tenant.dev.id, id],
  ));
}

beforeAll(async () => {
  t = await makeTenant("flowlib");
  other = await makeTenant("flowlib-other");
  await syncedWhatsAppTemplate(t);
});

describe("flows library", () => {
  it("creates a draft from a template with the mapped events, and nothing runs", async () => {
    const { id, audienceId } = await createAutomationFromTemplate(t.ctx, t.dev.id, "abandoned_cart", { events: { cart: "add_to_bag", purchase: "order_completed" } });
    expect(audienceId).toBeNull();
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

  it("applies every template as a valid draft, with copy in the chosen language", async () => {
    const before = (await listAutomations(t.ctx, t.dev.id)).length;
    for (const tpl of FLOW_TEMPLATE_IDS) {
      const { id, audienceId } = await createAutomationFromTemplate(t.ctx, t.dev.id, tpl, { whatsapp }, { t: makeT(AR) });
      const { automation: a } = await getAutomation(t.ctx, id);
      // What's stored parses as a definition the engine runs.
      expect(parseAutomation(a.definition)).toEqual(a.definition);
      expect(a.status).toBe("draft");
      expect(a.name).toBe(AR[getFlowTemplate(tpl).name]);
      expect(!!audienceId).toBe(!!getFlowTemplate(tpl).audience);
    }
    const flows = await listAutomations(t.ctx, t.dev.id);
    expect(flows.length - before).toBe(FLOW_TEMPLATE_IDS.length);
    expect(flows.every((f) => f.status === "draft")).toBe(true);
  });

  it("creates the audience an audience-started template needs, as a draft, and the flow activates once the audience is active", async () => {
    const { id, audienceId } = await createAutomationFromTemplate(t.ctx, t.dev.id, "lapsed_buyers", { events: { purchase: "order_paid" } });
    const audience = await getAudience(t.ctx, audienceId!);
    expect(audience.audience).toMatchObject({ status: "draft", name: "Lapsed buyers, 30+ days" });
    expect(JSON.stringify(audience.audience.definition)).toContain('"order_paid"');
    const { automation: a } = await getAutomation(t.ctx, id);
    expect(a.definition.trigger).toEqual({ type: "audience_entered", audienceId });
    expect(a.definition.goal).toMatchObject({ event: "order_paid" });

    await expect(activateAutomation(t.ctx, id)).rejects.toThrow(/Activate the audience/);
    await activateAudience(t.ctx, audienceId!);
    await activateAutomation(t.ctx, id);
    expect((await getAutomation(t.ctx, id)).automation.status).toBe("active");
  });

  it("needs an approved, synced WhatsApp template with its variables for a WhatsApp flow", async () => {
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "cart_whatsapp")).rejects.toThrow(/approved WhatsApp template/);
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "cart_whatsapp", { whatsapp: { ...whatsapp, template: "not_synced" } })).rejects.toThrow(/isn't synced/);
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "cart_whatsapp", { whatsapp: { ...whatsapp, bodyParams: [] } })).rejects.toThrow(/needs 1 body/);
    const { id } = await createAutomationFromTemplate(t.ctx, t.dev.id, "cart_whatsapp", { whatsapp });
    const { automation: a } = await getAutomation(t.ctx, id);
    expect(a.definition.steps.at(-1)).toMatchObject({ type: "whatsapp", template: "cart_reminder", language: "ar", bodyParams: ["{{user.first_name}}"], phoneProperty: "phone" });
  });

  it("rejects unknown templates and invalid mappings, and leaves nothing half-created", async () => {
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "nope")).rejects.toThrow(/Choose a flow from the library/);
    // Goal and trigger can't be the same event.
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "checkout_recovery", { events: { checkout: "x", purchase: "x" } })).rejects.toThrow(/different event/);
    const audiences = () => withSystem((db) => db.query("select id from platform.audiences where environment_id = $1", [t.dev.id]));
    const count = (await audiences()).length;
    await expect(createAutomationFromTemplate(t.ctx, t.dev.id, "lapsed_buyers", { events: { purchase: "x".repeat(201) } })).rejects.toThrow();
    expect((await audiences()).length).toBe(count);
  });

  it("needs the permission to create flows, in the member's own environments", async () => {
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "viewer" }, t.dev.id, "welcome_series")).rejects.toThrow(/permission/);
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "analyst" }, t.dev.id, "welcome_series")).rejects.toThrow(/permission/);
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "marketer" }, t.dev.id, "welcome_series")).resolves.toHaveProperty("id");
    await expect(createAutomationFromTemplate({ ...t.ctx, role: "marketer" }, t.dev.id, "win_back")).resolves.toHaveProperty("audienceId");
    await expect(createAutomationFromTemplate(other.ctx, t.dev.id, "welcome_series")).rejects.toThrow();
    await expect(createAutomationFromTemplate(other.ctx, t.dev.id, "win_back")).rejects.toThrow();
  });
});
