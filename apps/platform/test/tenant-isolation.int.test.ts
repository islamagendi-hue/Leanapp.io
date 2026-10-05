/**
 * Tenant isolation: Organization A must never read, modify, query or reach
 * Organization B's data, at the service layer *and* at the database layer
 * (RLS), even when a query omits its WHERE clause.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { getAppBySlug, listApps } from "@/modules/apps/service";
import { authenticateIngestionKey, createApiKey, createSdkKey, listKeys, revokeSdkKey } from "@/modules/credentials/service";
import { connectionHealth, liveEvents } from "@/modules/debugger/service";
import { implementationReport, saveAnswers } from "@/modules/implementation/service";
import { ingest } from "@/modules/ingestion/service";
import { changeMemberRole, listMembers } from "@/modules/organizations/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { resolveTenant } from "@/modules/tenancy/context";
import { makeTenant } from "./helpers";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;

async function seedData(t: T) {
  const principal = (await authenticateIngestionKey(t.sdkKey))!;
  await ingest(principal, {
    batch: [
      { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "anon-1", user_id: `secret-user-${t.org.slug}`, user_properties: { email_domain: "b.example" }, session_id: "s1" },
      { type: "track", event_name: "purchase_completed", event_id: crypto.randomUUID(), anonymous_id: "anon-1", user_id: `secret-user-${t.org.slug}`, session_id: "s1", properties: { revenue: 100, currency: "SAR", transaction_id: "t1" } },
      { type: "push_token", event_id: crypto.randomUUID(), anonymous_id: "anon-1", push_token: { token: "x".repeat(40), provider: "fcm", permission: "granted" } },
    ],
  }, { mode: "batch" });
  await processPendingEvents();
  await createApiKey(t.ctx, t.dev.id, { label: "server" });
  await saveAnswers(t.ctx, t.app.id, "business", { "business.description": "Food delivery", "business.model": "delivery", "business.customer_type": "b2c", "business.countries": ["SA"], "business.currencies": ["SAR"] });
}

beforeAll(async () => {
  A = await makeTenant("alpha");
  B = await makeTenant("bravo");
  await seedData(A);
  await seedData(B);
});

describe("tenant context", () => {
  it("cannot resolve another organization's tenant context", async () => {
    await expect(resolveTenant(A.user.id, B.org.slug)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Org A → Org B through services", () => {
  it("cannot read B's apps", async () => {
    await expect(getAppBySlug(A.ctx, B.app.slug)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listApps(A.ctx)).map((a) => a.id)).not.toContain(B.app.id);
  });
  it("cannot read B's API keys", async () => {
    const keys = await listKeys(A.ctx, B.app.id);
    expect(keys.sdkKeys).toHaveLength(0);
    expect(keys.apiKeys).toHaveLength(0);
  });
  it("cannot modify B's keys or create keys in B's environments", async () => {
    const bKey = (await listKeys(B.ctx, B.app.id)).sdkKeys[0];
    await expect(revokeSdkKey(A.ctx, bKey.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createSdkKey(A.ctx, B.dev.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await authenticateIngestionKey(bKey.key)).not.toBeNull(); // still active
  });
  it("cannot access B's events", async () => {
    expect(await liveEvents(A.ctx, B.dev.id)).toHaveLength(0);
    expect((await connectionHealth(A.ctx, B.dev.id)).eventsToday).toBe(0);
    expect((await liveEvents(B.ctx, B.dev.id)).length).toBeGreaterThan(0);
  });
  it("cannot access B's analytics / implementation data", async () => {
    await expect(implementationReport(A.ctx, B.app.id, B.dev.id)).rejects.toBeInstanceOf(NotFoundError);
  });
  it("cannot modify B's implementation project", async () => {
    await expect(saveAnswers(A.ctx, B.app.id, "business", {})).rejects.toBeInstanceOf(NotFoundError);
  });
  it("cannot see B's members or users", async () => {
    const members = await listMembers(A.ctx);
    expect(members.map((m) => m.user_id)).toEqual([A.user.id]);
    await expect(changeMemberRole(A.ctx, B.user.id, "analyst")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Org A → Org B at the database layer (RLS)", () => {
  const a = () => ({ organizationId: A.org.id, userId: A.user.id });

  it("sees zero rows of B in every tenant table, even without a WHERE clause", async () => {
    const tables = await withSystem((db) =>
      db.query<{ table_name: string; col: string }>(
        `select c.table_name, c.column_name as col from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
          where c.table_schema = 'platform' and t.table_type = 'BASE TABLE'
            and c.column_name in ('organization_id') `,
      ),
    );
    expect(tables.length).toBeGreaterThan(40);
    let bRowsSeenBySystem = 0;
    for (const { table_name } of tables) {
      const total = await withSystem((db) => db.one<{ n: string }>(`select count(*) as n from platform.${table_name} where organization_id = $1`, [B.org.id]));
      bRowsSeenBySystem += Number(total!.n);
      const visible = await withTenant(a(), (db) =>
        db.query(`select 1 from platform.${table_name} where organization_id <> $1`, [A.org.id]).catch((e) => {
          // Tables platform_app has no grant on are invisible by design.
          if ((e as { code?: string }).code === "42501") return [];
          throw e;
        }),
      );
      expect(visible, `${table_name} leaks rows of another organization`).toHaveLength(0);
    }
    expect(bRowsSeenBySystem).toBeGreaterThan(20); // B really has data in many tables
  });

  it("cannot read B's organization row or B's users", async () => {
    const orgs = await withTenant(a(), (db) => db.query("select id from platform.organizations"));
    expect(orgs.map((o) => o.id)).toEqual([A.org.id]);
    const users = await withTenant(a(), (db) => db.query("select id from platform.users"));
    expect(users.map((u) => u.id)).toEqual([A.user.id]);
  });

  it("cannot update or delete B's rows", async () => {
    const updated = await withTenant(a(), (db) => db.query("update platform.apps set name = 'pwned' where id = $1 returning id", [B.app.id]));
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(a(), (db) => db.query("delete from platform.events where organization_id = $1 returning id", [B.org.id]));
    expect(deleted).toHaveLength(0);
    const app = await withSystem((db) => db.one<{ name: string }>("select name from platform.apps where id = $1", [B.app.id]));
    expect(app!.name).not.toBe("pwned");
  });

  it("cannot insert rows into B", async () => {
    await expect(
      withTenant(a(), (db) => db.query("insert into platform.apps (organization_id, name, slug) values ($1, 'x', 'injected')", [B.org.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot point its own rows at B's parents (composite foreign keys)", async () => {
    await expect(
      withTenant(a(), (db) =>
        db.query("insert into platform.sdk_keys (organization_id, app_id, environment_id, key, key_hash) values ($1, $2, $3, 'k', 'h')", [A.org.id, B.app.id, B.dev.id]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("cannot read system-only tables (sessions, auth)", async () => {
    await expect(withTenant(a(), (db) => db.query("select * from platform.auth_sessions"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a(), (db) => db.query("select password_hash from platform.users"))).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot query anything without a tenant set", async () => {
    const rows = await withTenant({ organizationId: "00000000-0000-0000-0000-000000000000", userId: null }, (db) => db.query("select id from platform.apps"));
    expect(rows).toHaveLength(0);
  });
});

describe("RBAC", () => {
  it("enforces role permissions centrally", async () => {
    const analyst = { ...A.ctx, role: "analyst" as const };
    await expect(createSdkKey(analyst, A.dev.id)).rejects.toBeInstanceOf(ForbiddenError);
    const marketer = { ...A.ctx, role: "marketer" as const };
    await expect(listKeys(marketer, A.app.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("keeps at least one owner", async () => {
    await expect(changeMemberRole(A.ctx, A.user.id, "admin")).rejects.toThrow(/at least one owner/);
  });
});
