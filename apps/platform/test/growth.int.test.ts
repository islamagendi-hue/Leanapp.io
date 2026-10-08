/**
 * Phase 1 growth model and mapping history against a real Postgres:
 *   - growth state equals an independent reference computed from raw events,
 *     both when built event by event (out-of-order timestamps) and by the
 *     rebuild job;
 *   - identify merges an install into its one user; a shared device is never merged;
 *   - with the features off, processing writes exactly what it wrote before;
 *   - mapping history is recorded by the trigger, revert adds a revision, and
 *     the re-map job reaches events older than 30 days and beyond 5,000 events;
 *   - tenant isolation and privacy deletion cover the new tables.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { authenticateIngestionKey, listKeys } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { addPlanEvent, setDraftGrowth } from "@/modules/implementation/editor";
import { approveVersion, createMapping, listMappingHistory, publishVersion, revertMapping, decideMapping } from "@/modules/implementation/service";
import { growthOverview, previewDefinition, setGrowthModel, setMappingHistory } from "@/modules/growth/service";
import { runReprocessJobs } from "@/modules/reprocess/jobs";
import { requestDeletion, runDeletionJobs } from "@/modules/privacy/service";
import { PERSON } from "@/modules/analytics/sql";
import type { GrowthDefinition } from "@/modules/growth/definition";
import { localDate } from "@/modules/analytics/range";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
const DAY = 86_400_000;
/** makeTenant creates apps in Asia/Riyadh (the organization default). */
const TIMEZONE = "Asia/Riyadh";

const DEFINITION = {
  activation: { event: "signup_completed", filters: [{ name: "method", op: "eq", value: "email" }] },
  core_action: { event: "order_completed", filters: [] },
  revenue: { event: "order_completed", amount_property: "revenue", currency_property: "currency" },
  retention: { return_event: "any" },
};

async function sdkFor(t: T, environmentId: string) {
  const keys = await listKeys(t.ctx, t.app.id);
  return (await authenticateIngestionKey(keys.sdkKeys.find((k) => k.environment_id === environmentId)!.key))!;
}

/** Sends events, then moves their timestamps (ingestion only accepts the last 31 days). */
async function send(t: T, environmentId: string, events: (Record<string, unknown> & { at?: number })[]) {
  const sdk = await sdkFor(t, environmentId);
  const stamped = events.map(({ at, ...e }) => ({ ...e, event_id: crypto.randomUUID(), _at: at }));
  for (let i = 0; i < stamped.length; i += 50) {
    const batch = stamped.slice(i, i + 50).map(({ _at, ...e }) => e);
    const res = await ingest(sdk, { batch }, { mode: "batch" });
    expect((res.body as { accepted: number }).accepted).toBe(batch.length);
  }
  const moved = stamped.filter((e) => e._at !== undefined);
  if (moved.length) {
    await withSystem((db) =>
      db.query(
        `update platform.events e set "timestamp" = v.ts from unnest($1::text[], $2::timestamptz[]) v(id, ts) where e.environment_id = $3 and e.event_id = v.id`,
        [moved.map((e) => e.event_id), moved.map((e) => new Date(e._at!)), environmentId],
      ),
    );
  }
}

async function drain() {
  for (let i = 0; i < 100; i++) {
    const r = await processPendingEvents({ limit: 2000 });
    if (!r.processed && !r.failed) break;
  }
}

async function runJobs() {
  for (let i = 0; i < 200; i++) {
    const r = await runReprocessJobs({ deadline: Date.now() + 20_000 });
    if (!r.chunks) break;
  }
}

async function planWithGrowth(t: T) {
  const me = { kind: "user" as const, ctx: t.ctx };
  await addPlanEvent(me, t.app.id, { event_name: "signup_completed", properties: [{ name: "method", type: "string" }] });
  await addPlanEvent(me, t.app.id, { event_name: "order_completed", properties: [{ name: "revenue", type: "number" }, { name: "currency", type: "string" }] });
  const draft = await setDraftGrowth(me, t.app.id, DEFINITION);
  await approveVersion(t.ctx, t.app.id, draft.versionId);
  await publishVersion(t.ctx, t.app.id, draft.versionId);
}

/** A mixed population: identified and anonymous people, string and numeric amounts, a shared device, 0–60 days old. */
function population(seed: number) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const now = Date.now();
  const events: (Record<string, unknown> & { at?: number })[] = [];
  for (let p = 0; p < 24; p++) {
    const anon = `install-${seed}-${p}`;
    const user = p % 3 === 0 ? null : `user-${seed}-${p}`;
    const start = now - Math.floor(rnd() * 60) * DAY - Math.floor(rnd() * DAY);
    const n = 2 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const at = Math.min(now - 60_000, start + Math.floor(rnd() * 40) * DAY + Math.floor(rnd() * DAY));
      const kind = rnd();
      const base = { anonymous_id: anon, at, ...(user && rnd() < 0.6 ? { user_id: user } : {}) };
      if (kind < 0.15) events.push({ ...base, type: "track", event_name: "signup_completed", properties: { method: rnd() < 0.7 ? "email" : "phone" } });
      else if (kind < 0.4) {
        const amount = Math.round(rnd() * 10000) / 100;
        events.push({ ...base, type: "track", event_name: "order_completed", properties: { revenue: rnd() < 0.3 ? String(amount) : amount, ...(rnd() < 0.7 ? { currency: rnd() < 0.5 ? "usd" : "SAR" } : {}) } });
      } else if (kind < 0.5) events.push({ ...base, type: "screen", event_name: "Home" });
      else events.push({ ...base, type: "track", event_name: "item_viewed" });
    }
    if (user) events.push({ type: "identify", anonymous_id: anon, user_id: user, at: start + DAY, user_properties: { plan: "free" } });
  }
  // A shared device: two users signed in on one install.
  const shared = `shared-${seed}`;
  events.push({ type: "track", event_name: "item_viewed", anonymous_id: shared, at: now - 20 * DAY });
  events.push({ type: "identify", anonymous_id: shared, user_id: `sa-${seed}`, at: now - 19 * DAY });
  events.push({ type: "identify", anonymous_id: shared, user_id: `sb-${seed}`, at: now - 18 * DAY });
  events.push({ type: "track", event_name: "order_completed", anonymous_id: shared, at: now - 17 * DAY, properties: { revenue: 5, currency: "SAR" } });
  // Events in a random order, so many arrive before earlier ones (late or offline events).
  return events.sort(() => rnd() - 0.5);
}

interface StateRow {
  person: string;
  first_seen_at: number;
  last_active_at: number;
  activated_at: number | null;
  first_core_action_at: number | null;
  core_action_count: number;
  first_revenue_at: number | null;
  revenue: Record<string, number>;
  purchases: number;
  retained_d1_at: number | null;
  retained_d7_at: number | null;
  retained_d30_at: number | null;
}

/** Independent reference: plain TypeScript over the raw events and the analytics person key. */
async function reference(environmentId: string, def: GrowthDefinition, currency: string): Promise<StateRow[]> {
  const rows = await withSystem((db) =>
    db.query<{ person: string; name: string; ts: Date; properties: Record<string, unknown> }>(
      `select ${PERSON.expr} as person, coalesce(e.canonical_name, e.event_name) as name, e."timestamp" as ts, e.properties
         from platform.events e ${PERSON.join}
        where e.environment_id = $1 and e.type in ('track', 'screen') and e.processed_at is not null and e.processing_error is null`,
      [environmentId],
    ),
  );
  const byPerson = new Map<string, typeof rows>();
  for (const r of rows) byPerson.set(r.person, [...(byPerson.get(r.person) ?? []), r]);
  const amount = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);
  const matches = (rule: GrowthDefinition["activation"], r: (typeof rows)[number]) =>
    !!rule && r.name === rule.event && rule.filters.every((f) => f.op === "eq" && String(r.properties[f.name]) === f.value);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  return [...byPerson.entries()].map(([person, evs]) => {
    const ts = evs.map((e) => e.ts.getTime());
    const first = Math.min(...ts);
    const purchases = evs.filter((e) => def.revenue && e.name === def.revenue.event && amount(e.properties[def.revenue.amount_property]) !== null);
    const revenue: Record<string, number> = {};
    for (const e of purchases) {
      const c = e.properties[def.revenue!.currency_property];
      const cur = typeof c === "string" && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : currency;
      revenue[cur] = Math.round(((revenue[cur] ?? 0) + amount(e.properties[def.revenue!.amount_property])!) * 100) / 100;
    }
    const core = evs.filter((e) => matches(def.core_action, e));
    // Retained on day N: an event on the calendar day N days after the first one, in the app's timezone.
    const dayOf = (ms: number) => Date.parse(localDate(new Date(ms), TIMEZONE));
    const retained = (d: number) => min(ts.filter((t) => dayOf(t) - dayOf(first) === d * DAY));
    return {
      person,
      first_seen_at: first,
      last_active_at: Math.max(...ts),
      activated_at: min(evs.filter((e) => matches(def.activation, e)).map((e) => e.ts.getTime())),
      first_core_action_at: min(core.map((e) => e.ts.getTime())),
      core_action_count: core.length,
      first_revenue_at: min(purchases.map((e) => e.ts.getTime())),
      revenue,
      purchases: purchases.length,
      retained_d1_at: retained(1),
      retained_d7_at: retained(7),
      retained_d30_at: retained(30),
    };
  }).sort((a, b) => a.person.localeCompare(b.person));
}

async function state(environmentId: string): Promise<StateRow[]> {
  const rows = await withSystem((db) => db.query<Record<string, unknown>>("select * from platform.growth_state where environment_id = $1 order by person", [environmentId]));
  const t = (v: unknown) => (v ? (v as Date).getTime() : null);
  return rows
    .map((r) => ({
      person: r.person as string,
      first_seen_at: t(r.first_seen_at)!,
      last_active_at: t(r.last_active_at)!,
      activated_at: t(r.activated_at),
      first_core_action_at: t(r.first_core_action_at),
      core_action_count: Number(r.core_action_count),
      first_revenue_at: t(r.first_revenue_at),
      revenue: Object.fromEntries(Object.entries(r.revenue as Record<string, number>).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100])),
      purchases: Number(r.purchases),
      retained_d1_at: t(r.retained_d1_at),
      retained_d7_at: t(r.retained_d7_at),
      retained_d30_at: t(r.retained_d30_at),
    }))
    .sort((a, b) => a.person.localeCompare(b.person));
}

describe("growth state", () => {
  let t: T;
  let def: GrowthDefinition;

  beforeAll(async () => {
    t = await makeTenant("growth");
    await planWithGrowth(t);
    def = (await growthOverview(t.ctx, t.app.id, t.dev.id)).definitions.published!.definition;
  });

  it("is off by default: processing writes no growth state", async () => {
    await send(t, t.dev.id, population(1).slice(0, 20));
    await drain();
    expect(await state(t.dev.id)).toEqual([]);
    expect((await growthOverview(t.ctx, t.app.id, t.dev.id)).enabled).toBe(false);
  });

  it("the first build after turning it on matches the reference", async () => {
    await setGrowthModel(t.ctx, t.app.id, true);
    await runJobs();
    expect(await state(t.dev.id)).toEqual(await reference(t.dev.id, def, "SAR"));
  });

  it("stays equal to the reference event by event, with out-of-order and late events", async () => {
    await send(t, t.dev.id, population(2));
    await drain();
    const expected = await reference(t.dev.id, def, "SAR");
    expect(expected.length).toBeGreaterThan(20);
    expect(expected.some((r) => r.retained_d7_at) && expected.some((r) => r.purchases > 0) && expected.some((r) => r.activated_at)).toBe(true);
    expect(await state(t.dev.id)).toEqual(expected);
  });

  it("a rebuild from scratch gives the same rows", async () => {
    await withSystem((db) => db.query("update platform.growth_state set core_action_count = 999, revenue = '{}' where environment_id = $1", [t.dev.id]));
    await withSystem((db) => db.query("insert into platform.growth_state (organization_id, app_id, environment_id, person, first_seen_at, last_active_at, updated_at) values ($1, $2, $3, 'ghost', now(), now(), now() - interval '1 day')", [t.org.id, t.app.id, t.dev.id]));
    await setGrowthModel(t.ctx, t.app.id, false);
    await setGrowthModel(t.ctx, t.app.id, true);
    await runJobs();
    expect(await state(t.dev.id)).toEqual(await reference(t.dev.id, def, "SAR"));
  });

  it("identify merges an install into its one user; a shared device stays separate", async () => {
    const now = Date.now();
    await send(t, t.dev.id, [
      { type: "track", event_name: "item_viewed", anonymous_id: "merge-me", at: now - 3 * DAY },
      { type: "track", event_name: "signup_completed", anonymous_id: "merge-me", properties: { method: "email" }, at: now - 3 * DAY + 1000 },
    ]);
    await drain();
    const persons = async () => (await state(t.dev.id)).map((r) => r.person);
    expect(await persons()).toContain("anon:merge-me");

    await send(t, t.dev.id, [{ type: "identify", anonymous_id: "merge-me", user_id: "merged-user", at: now - 2 * DAY }]);
    await drain();
    let rows = await state(t.dev.id);
    expect(rows.map((r) => r.person)).not.toContain("anon:merge-me");
    const merged = rows.find((r) => r.person === "merged-user")!;
    expect(merged.first_seen_at).toBe(now - 3 * DAY);
    expect(merged.activated_at).toBe(now - 3 * DAY + 1000);

    // A second user on the same install: the install's anonymous events go back to the install.
    await send(t, t.dev.id, [{ type: "identify", anonymous_id: "merge-me", user_id: "second-user", at: now - DAY }]);
    await drain();
    rows = await state(t.dev.id);
    expect(rows.find((r) => r.person === "anon:merge-me")?.activated_at).toBe(now - 3 * DAY + 1000);
    expect(rows.find((r) => r.person === "merged-user")).toBeUndefined(); // it only had the install's events
    expect(rows).toEqual(await reference(t.dev.id, def, "SAR"));
  });

  it("the summary and the 30-day preview count the same people as the rows", async () => {
    const overview = await growthOverview(t.ctx, t.app.id, t.dev.id);
    const rows = await state(t.dev.id);
    expect(overview.summary!.people).toBe(rows.length);
    expect(overview.summary!.activated).toBe(rows.filter((r) => r.activated_at).length);
    expect(overview.summary!.paying).toBe(rows.filter((r) => r.purchases > 0).length);
    const preview = await previewDefinition(t.ctx, t.app.id, t.dev.id, DEFINITION);
    expect(preview.people).toBeGreaterThan(0);
    expect(preview.people).toBeLessThanOrEqual(rows.length);
    expect(preview.revenue.map((r) => r.currency).every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  });

  it("is isolated per tenant and removed by privacy deletion", async () => {
    const other = await makeTenant("growth-other");
    const seen = await withTenant({ organizationId: other.org.id, userId: other.user.id }, (db) =>
      db.query("select 1 from platform.growth_state where environment_id = $1", [t.dev.id]),
    );
    expect(seen).toEqual([]);
    const target = (await state(t.dev.id)).find((r) => !r.person.startsWith("anon:") && !r.person.startsWith("s"))!;
    await requestDeletion({ kind: "user", ctx: t.ctx }, t.dev.id, { userId: target.person });
    await runDeletionJobs({ limit: 10 });
    expect((await state(t.dev.id)).map((r) => r.person)).not.toContain(target.person);
  });
});

describe("feature switches off", () => {
  it("processing writes exactly the same rows as before Phase 1", async () => {
    const a = await makeTenant("gate-off");
    const b = await makeTenant("gate-on");
    for (const t of [a, b]) await planWithGrowth(t);
    await setGrowthModel(b.ctx, b.app.id, true);
    await setMappingHistory(b.ctx, b.app.id, true);
    const events = population(7);
    await send(a, a.dev.id, events);
    await send(b, b.dev.id, events);
    await drain();
    const snapshot = (env: string) =>
      withSystem(async (db) => ({
        events: await db.query(`select event_name, "timestamp", anonymous_id, user_id, canonical_name, processing_error, (processed_at is not null) as processed
                    from platform.events where environment_id = $1 order by "timestamp", event_name, anonymous_id, user_id nulls first, properties::text`, [env]),
        anonymous: await db.query("select anonymous_id, first_seen_at, last_seen_at from platform.anonymous_users where environment_id = $1 order by 1", [env]),
        users: await db.query("select external_id, properties, first_seen_at, last_seen_at from platform.app_users where environment_id = $1 order by 1", [env]),
        links: await db.query("select anonymous_id, user_id, first_linked_at from platform.identity_links where environment_id = $1 order by 1, 2", [env]),
        status: await db.query("select event_name, status, received_count, valid_count, invalid_count from platform.tracking_implementation_status where environment_id = $1 order by 1", [env]),
      }));
    expect(await snapshot(b.dev.id)).toEqual(await snapshot(a.dev.id));
    expect((await state(a.dev.id)).length).toBe(0);
    expect((await state(b.dev.id)).length).toBeGreaterThan(0);
  });
});

describe("mapping history and full re-map", () => {
  let t: T;
  beforeAll(async () => {
    t = await makeTenant("remap");
    await planWithGrowth(t);
  });

  it("records every change, and revert adds a revision", async () => {
    await createMapping(t.ctx, t.app.id, "Purchase", "order_completed");
    await createMapping(t.ctx, t.app.id, "Purchase", "signup_completed");
    let history = await listMappingHistory(t.ctx, t.app.id);
    expect(history.map((h) => [h.revision, h.to_name, h.status])).toEqual([[2, "signup_completed", "accepted"], [1, "order_completed", "accepted"]]);
    expect(history[0].changed_by_email).toMatch(/@example.com/);
    const mappingId = history[0].mapping_id;

    await expect(revertMapping(t.ctx, t.app.id, mappingId, 1)).rejects.toThrow(/mapping history/);
    await setMappingHistory(t.ctx, t.app.id, true);
    await revertMapping(t.ctx, t.app.id, mappingId, 1);
    history = await listMappingHistory(t.ctx, t.app.id);
    expect(history[0]).toMatchObject({ revision: 3, to_name: "order_completed", status: "accepted", reverted_to: 1 });
    await decideMapping(t.ctx, t.app.id, mappingId, false);
    expect((await listMappingHistory(t.ctx, t.app.id))[0]).toMatchObject({ revision: 4, status: "rejected", reverted_to: null });

    // Append-only for the app role.
    await expect(
      withTenant({ organizationId: t.org.id, userId: t.user.id }, (db) => db.query("delete from platform.event_mapping_history where app_id = $1", [t.app.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("re-maps every past event, older than 30 days and beyond 5,000 events", async () => {
    await setGrowthModel(t.ctx, t.app.id, true);
    // 6,000 already-processed events from 40–100 days ago under the raw name "Checkout".
    await withSystem((db) =>
      db.query(
        `insert into platform.events (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", received_at, anonymous_id, source, properties, processed_at)
         select $1, $2, $3, 'old-' || g, 'track', 'Checkout', now() - interval '40 days' - (g % 60) * interval '1 day', now() - interval '40 days' - (g % 60) * interval '1 day',
                'old-install-' || (g % 50), 'mobile_sdk', jsonb_build_object('revenue', 10, 'currency', 'SAR'), now() - interval '40 days'
           from generate_series(1, 6000) g`,
        [t.org.id, t.app.id, t.dev.id],
      ),
    );
    // Their installs, as processing would have recorded them.
    await withSystem((db) =>
      db.query(
        `insert into platform.anonymous_users (organization_id, app_id, environment_id, anonymous_id, first_seen_at, last_seen_at, first_context)
         select $1, $2, $3, 'old-install-' || g, now() - interval '100 days', now() - interval '40 days', '{}' from generate_series(0, 49) g`,
        [t.org.id, t.app.id, t.dev.id],
      ),
    );
    await runJobs();
    await createMapping(t.ctx, t.app.id, "Checkout", "order_completed");
    const unmapped = () =>
      withSystem(async (db) => Number((await db.one<{ n: string }>("select count(*) as n from platform.events where environment_id = $1 and event_name = 'Checkout' and canonical_name is distinct from 'order_completed'", [t.dev.id]))!.n));
    expect(await unmapped()).toBe(6000); // the instant pass only looks at the last 30 days
    await runJobs();
    expect(await unmapped()).toBe(0);
    // The re-map is followed by a growth rebuild, so those orders count as core actions and revenue.
    const overview = await growthOverview(t.ctx, t.app.id, t.dev.id);
    expect(overview.jobs.filter((j) => j.status === "done").map((j) => j.kind).sort()).toEqual(["growth_rebuild", "remap"]);
    expect(overview.summary!.purchases).toBe(6000);
    expect(overview.summary!.revenue).toEqual([{ currency: "SAR", total: 60000 }]);
  });
});
