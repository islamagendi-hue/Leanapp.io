/**
 * PR 12: the flow builder's engine features. Branches with a separate
 * "no" path and an Exit step, conversion goals with stop on conversion and
 * goal reporting, and exit events.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { enqueueTriggers, stepRuns } from "@/modules/automation/engine";
import { activateAutomation, createAutomation, getAutomation, goalReport } from "@/modules/automation/service";
import { authenticateIngestionKey, type IngestionPrincipal } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T;
let sdk: IngestionPrincipal;

const send = async (batch: Record<string, unknown>[]) => {
  await ingest(sdk, { batch: batch.map((e) => ({ type: "track", event_id: crypto.randomUUID(), ...e })) }, { mode: "batch" });
  await processPendingEvents({ environmentId: t.dev.id, limit: 1000 });
};
const cycle = async () => {
  await enqueueTriggers();
  await stepRuns();
};
const makeDue = (id: string) => withSystem((db) => db.query("update platform.automation_runs set next_run_at = now() - interval '1 second' where automation_id = $1 and status in ('pending', 'waiting')", [id]));
const NO_GUARDS = { quietHours: null, frequencyCap: null };
const flow = async (name: string, definition: Record<string, unknown>) => {
  const { id } = await createAutomation(t.ctx, t.dev.id, { name, definition: { ...NO_GUARDS, ...definition } });
  await activateAutomation(t.ctx, id);
  return id;
};
const inbox = async (id: string) =>
  (await withSystem((db) => db.query<{ user_key: string; title: string }>("select user_key, title from platform.in_app_messages where automation_id = $1 order by user_key", [id]))).map((r) => `${r.user_key}:${r.title}`);
const exits = async (id: string) =>
  (await getAutomation(t.ctx, id)).runs.flatMap((r) => r.log.filter((l) => l.outcome === "exit").map((l) => `${r.user_key}:${l.detail}`)).sort();

beforeAll(async () => {
  t = await makeTenant("flows");
  sdk = (await authenticateIngestionKey(t.sdkKey))!;
  await send([
    { type: "identify", user_id: "vip", user_properties: { vip: true } },
    { type: "identify", user_id: "reg", user_properties: { vip: false } },
  ]);
});

describe("flow builder engine", () => {
  it("runs a branch's yes path and its no path separately, with Exit between them", async () => {
    const id = await flow("VIP split", {
      trigger: { type: "event", event: "cart_started" },
      steps: [
        { type: "branch", condition: { type: "user_property", property: "vip", op: "eq", value: true }, else: { goto: 3 } },
        { type: "in_app", title: "VIP offer", body: "x" },
        { type: "exit" },
        { type: "in_app", title: "Regular offer", body: "x" },
      ],
    });
    await send([{ event_name: "cart_started", user_id: "vip" }, { event_name: "cart_started", user_id: "reg" }]);
    await cycle();
    expect(await inbox(id)).toEqual(["reg:Regular offer", "vip:VIP offer"]);
    expect(await exits(id)).toEqual(["vip:Exit step"]);
    expect(await goalReport(t.ctx, id)).toBeNull();
  });

  it("stops people who reach the goal and reports conversions from the event stream", async () => {
    const id = await flow("Signup nudge", {
      trigger: { type: "event", event: "signed_up" },
      steps: [{ type: "delay", amount: 1, unit: "hours" }, { type: "in_app", title: "Finish your first order", body: "x" }],
      goal: { event: "order_placed", withinDays: 7, stopOnConversion: true },
    });
    await send([{ event_name: "signed_up", user_id: "vip" }, { event_name: "signed_up", user_id: "reg" }]);
    await cycle(); // both now wait an hour
    await send([{ event_name: "order_placed", user_id: "vip" }]);
    await makeDue(id);
    await cycle();
    expect(await inbox(id)).toEqual(["reg:Finish your first order"]);
    expect(await exits(id)).toEqual(["vip:Converted: did order_placed"]);
    const r = (await goalReport(t.ctx, id))!;
    expect(r).toMatchObject({ entered: 2, converted: 1, open: 1, stopped: 1, goal: { event: "order_placed", withinDays: 7 } });
    expect(r.medianSeconds).toBeGreaterThanOrEqual(0);
    // reg converts later: counted, though the message already went out.
    await send([{ event_name: "order_placed", user_id: "reg" }]);
    expect((await goalReport(t.ctx, id))!).toMatchObject({ converted: 2, open: 0, stopped: 1 });
  });

  it("keeps going after conversion when stop on conversion is off, and ends runs on the exit event", async () => {
    const keep = await flow("Keep going", {
      trigger: { type: "event", event: "trial_started" },
      steps: [{ type: "delay", amount: 1, unit: "hours" }, { type: "in_app", title: "Tips", body: "x" }],
      goal: { event: "subscribed", withinDays: 14, stopOnConversion: false },
      exitEvent: "app_uninstalled",
    });
    await send([{ event_name: "trial_started", user_id: "vip" }, { event_name: "trial_started", user_id: "reg" }]);
    await cycle();
    await send([{ event_name: "subscribed", user_id: "vip" }, { event_name: "app_uninstalled", user_id: "reg" }]);
    await makeDue(keep);
    await cycle();
    expect(await inbox(keep)).toEqual(["vip:Tips"]);
    expect(await exits(keep)).toEqual(["reg:Exit event: did app_uninstalled"]);
    expect(await goalReport(t.ctx, keep)).toMatchObject({ entered: 2, converted: 1, stopped: 0 });
  });

  it("rejects a goal or exit event that is the trigger itself", async () => {
    const base = { ...NO_GUARDS, trigger: { type: "event", event: "signed_up" }, steps: [{ type: "exit" }] };
    await expect(createAutomation(t.ctx, t.dev.id, { name: "Bad goal", definition: { ...base, goal: { event: "signed_up" } } })).rejects.toThrow(/goal must be a different event/);
    await expect(createAutomation(t.ctx, t.dev.id, { name: "Bad exit", definition: { ...base, exitEvent: "signed_up" } })).rejects.toThrow(/exit event must be a different event/);
    const { id } = await createAutomation(t.ctx, t.dev.id, { name: "Defaults", definition: { ...base, goal: { event: "order_placed" } } });
    expect((await getAutomation(t.ctx, id)).automation.definition).toMatchObject({ goal: { event: "order_placed", withinDays: 7, stopOnConversion: true }, exitEvent: null });
  });
});
