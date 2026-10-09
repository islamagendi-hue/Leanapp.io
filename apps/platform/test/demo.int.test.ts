/**
 * The public demo against Postgres: created once, filled with sample events
 * that a refresh never duplicates, and signed in as a read-only Viewer.
 */
import { describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { getUserBySessionToken } from "@/modules/auth/service";
import { DEMO_EMAIL, demoEvents, demoSession, ensureDemo, isDemoUser } from "@/modules/marketing/demo";

const now = new Date();

async function counts(environmentId: string) {
  return withSystem((db) =>
    db.one<{ events: number; orders: number }>(
      `select count(*)::int as events, count(*) filter (where event_name = 'order_completed')::int as orders
         from platform.events where environment_id = $1`,
      [environmentId],
    ),
  );
}

describe("public demo", () => {
  it("generates the same journeys whatever day it runs, all in the past", () => {
    const a = demoEvents(now);
    const b = demoEvents(now);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1000);
    expect(new Set(a.map((e) => e.event_id)).size).toBe(a.length);
    expect(a.every((e) => new Date(e.timestamp as string) < now)).toBe(true);
    // Tomorrow's set keeps today's journeys' ids (that's what makes a refresh idempotent).
    const later = new Set(demoEvents(new Date(now.getTime() + 86_400_000)).map((e) => e.event_id));
    expect(a.filter((e) => later.has(e.event_id as string)).length).toBeGreaterThan(a.length * 0.8);
  });

  it("creates the demo once, and a refresh adds nothing it already has", async () => {
    const refs = await ensureDemo({ now, staleHours: 0 });
    const first = (await counts(refs.environmentId))!;
    expect(first.events).toBeGreaterThan(1000);
    expect(first.orders).toBeGreaterThan(20);

    const again = await ensureDemo({ now, staleHours: 0 });
    expect(again).toEqual(refs);
    expect(await counts(refs.environmentId)).toEqual(first);

    const role = await withSystem((db) =>
      db.one<{ role_id: string }>(
        "select m.role_id from platform.organization_members m join platform.organizations o on o.id = m.organization_id where o.slug = $1 and m.user_id = $2",
        [refs.orgSlug, refs.viewerId],
      ),
    );
    expect(role?.role_id).toBe("viewer");
  });

  it("signs in as the demo Viewer", async () => {
    const refs = await ensureDemo({ now });
    const s = await demoSession(refs, "vitest");
    const user = await getUserBySessionToken(s.token);
    expect(user?.email).toBe(DEMO_EMAIL);
    expect(isDemoUser(user)).toBe(true);
    expect(isDemoUser({ email: "someone@example.com" })).toBe(false);
  });
});
