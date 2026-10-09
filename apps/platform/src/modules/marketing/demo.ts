import "server-only";
import { msg } from "@/i18n/translate";
import { createHash } from "node:crypto";
import { randomToken } from "@/lib/crypto";
import { withSystem } from "@/lib/db";
import { createApp, getAppBySlug } from "@/modules/apps/service";
import { createSession, signUp } from "@/modules/auth/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { ingest } from "@/modules/ingestion/service";
import { createOrganization } from "@/modules/organizations/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { resolveTenant } from "@/modules/tenancy/context";

/**
 * The public demo: an organization with one food-delivery app whose
 * production environment holds the last 30 days of made-up activity. Anyone
 * can open it from the landing page (/demo) as a read-only Viewer; nothing in
 * it is real.
 *
 * It is on only when DEMO_ENABLED=1. The data is generated from a fixed seed,
 * so refreshing it re-sends the same events (ingestion drops duplicates by
 * event_id) plus the days that have passed since, which keeps the reports
 * current without growing.
 */
export const DEMO_EMAIL = "demo@leanapp.io";
const OWNER_EMAIL = "demo-owner@leanapp.io";
export const DEMO_ORG_NAME = "Demo Foods";
export const DEMO_APP_NAME = "Food Express";
const DAYS = 30;
const USERS_PER_DAY = 14;

export const demoEnabled = () => process.env.DEMO_ENABLED === "1";
/** What the demo account sees when it tries to change itself or create an organization. */
export const DEMO_LOCKED = msg("This is the shared demo account, so it can't be changed. Create a free account to try this.");
export const isDemoUser = (user: { email: string } | null | undefined) => user?.email.toLowerCase() === DEMO_EMAIL;

export interface DemoRefs {
  viewerId: string;
  orgSlug: string;
  appSlug: string;
  environmentId: string;
}

async function findDemo(): Promise<DemoRefs | null> {
  return withSystem(async (db) => {
    const row = await db.one<{ viewer_id: string; org_slug: string; app_slug: string; environment_id: string }>(
      `select v.id as viewer_id, o.slug as org_slug, a.slug as app_slug, e.id as environment_id
         from platform.users v
         join platform.organization_members m on m.user_id = v.id
         join platform.organizations o on o.id = m.organization_id and o.status = 'active'
         join platform.apps a on a.organization_id = o.id and a.status = 'active'
         join platform.environments e on e.app_id = a.id and e.type = 'production'
        where lower(v.email) = $1
        order by a.created_at limit 1`,
      [DEMO_EMAIL],
    );
    return row && { viewerId: row.viewer_id, orgSlug: row.org_slug, appSlug: row.app_slug, environmentId: row.environment_id };
  });
}

/** Creates the demo organization, app and Viewer account. Their passwords are random and never used: /demo signs in directly. */
async function createDemo(): Promise<DemoRefs> {
  const { user: owner } = await signUp({ name: "LeanApp Demo", email: OWNER_EMAIL, password: randomToken(24) }, { ip: "demo" });
  const { user: viewer } = await signUp({ name: "Demo visitor", email: DEMO_EMAIL, password: randomToken(24) }, { ip: "demo" });
  const org = await createOrganization(owner.id, { name: DEMO_ORG_NAME, country: "SA", timezone: "Asia/Riyadh", defaultCurrency: "SAR", industry: "" });
  const ctx = await resolveTenant(owner.id, org.slug);
  const app = await createApp(ctx, { name: DEMO_APP_NAME, description: "Food delivery app (sample data)", platforms: ["android", "ios"] });
  await withSystem(async (db) => {
    await db.query("update platform.users set email_verified_at = now() where id = any($1::uuid[])", [[owner.id, viewer.id]]);
    await db.query("insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, 'viewer') on conflict do nothing", [
      org.id,
      viewer.id,
    ]);
  });
  const { environments } = await getAppBySlug(ctx, app.slug);
  return { viewerId: viewer.id, orgSlug: org.slug, appSlug: app.slug, environmentId: environments.find((e) => e.type === "production")!.id };
}

/** A deterministic event id, so re-sending a day's events never duplicates them. */
function eventId(key: string): string {
  const h = createHash("sha256").update(`leanapp-demo:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A small seeded random generator (Park–Miller). */
function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const SOURCES = [
  { source: "tiktok", campaign: "tiktok_ramadan", weight: 0.24 },
  { source: "snapchat", campaign: "snap_weekend_deals", weight: 0.2 },
  { source: "google", campaign: "search_brand", weight: 0.16 },
  { source: "meta", campaign: "meta_lookalike", weight: 0.14 },
  { source: null, campaign: null, weight: 0.26 },
];
const CITIES = ["Riyadh", "Jeddah", "Dammam", "Dubai", "Cairo"];
const CUISINES = ["burger", "shawarma", "pizza", "sushi", "mandi"];

/**
 * The demo's events with timestamps in the last 30 days, as SDK batches would
 * send them: people install on a day (by acquisition source), most sign up,
 * and come back to order over the following days. Each person's journey is
 * fixed by their day and number, whatever day it is generated on.
 */
export function demoEvents(now: Date): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const today = Math.floor(now.getTime() / 86_400_000);
  for (let day = today - DAYS + 1; day <= today; day++) {
    const dayRand = rng(day);
    const count = USERS_PER_DAY + Math.floor(dayRand() * 8) - 3;
    for (let n = 0; n < count; n++) {
      const r = rng(day * 1000 + n + 7);
      const id = `${day}-${n}`;
      const pick = r();
      let acc = 0;
      const src = SOURCES.find((s) => (acc += s.weight) >= pick) ?? SOURCES[SOURCES.length - 1];
      const anon = `demo-device-${id}`;
      const uid = `user_${id}`;
      const platform = r() < 0.62 ? "android" : "ios";
      const context = {
        platform,
        app_version: r() < 0.8 ? "3.2.0" : "3.1.4",
        locale: r() < 0.7 ? "ar-SA" : "en-SA",
        country: "SA",
        ...(src.source ? { attribution: { utm_source: src.source, utm_medium: "paid", utm_campaign: src.campaign } } : {}),
      };
      let t = day * 86_400_000 + (8 + Math.floor(r() * 14)) * 3_600_000 + Math.floor(r() * 3_600_000);
      let seq = 0;
      const push = (ev: Record<string, unknown>) => {
        t += 20_000 + Math.floor(r() * 400_000);
        if (t > now.getTime() - 60_000) return;
        out.push({ ...ev, event_id: eventId(`${id}-${seq++}`), anonymous_id: anon, session_id: `demo-s-${id}-${Math.floor(t / 86_400_000)}`, timestamp: new Date(t).toISOString(), context });
      };
      push({ type: "track", event_name: "app_installed" });
      push({ type: "screen", name: "Home" });
      if (r() > 0.72) continue;
      const plan = r() < 0.25 ? "plus" : "free";
      push({ type: "identify", user_id: uid, user_properties: { city: CITIES[Math.floor(r() * CITIES.length)], plan, language: context.locale.slice(0, 2) } });
      push({ type: "track", event_name: "signup_completed", user_id: uid, properties: { method: r() < 0.6 ? "phone" : "apple" } });
      const sessions = 1 + Math.floor(r() * (plan === "plus" ? 7 : 4));
      for (let s = 0; s < sessions; s++) {
        if (s > 0) t += (1 + Math.floor(r() * 4)) * 86_400_000 + Math.floor(r() * 6) * 3_600_000;
        push({ type: "track", event_name: "app_opened", user_id: uid });
        const cuisine = CUISINES[Math.floor(r() * CUISINES.length)];
        push({ type: "track", event_name: "restaurant_viewed", user_id: uid, properties: { restaurant_id: `r${Math.floor(r() * 40)}`, cuisine } });
        if (r() > 0.62) continue;
        const price = 25 + Math.floor(r() * 70);
        push({ type: "track", event_name: "product_added_to_cart", user_id: uid, properties: { price, cuisine } });
        if (r() > 0.74) continue;
        push({ type: "track", event_name: "checkout_started", user_id: uid, properties: { value: price + 12 } });
        if (r() > 0.8) continue;
        push({
          type: "track",
          event_name: "order_completed",
          user_id: uid,
          properties: { order_id: `o-${id}-${s}`, revenue: price + 12, currency: "SAR", payment_method: r() < 0.55 ? "card" : "cash", cuisine },
        });
      }
    }
  }
  return out;
}

/** The demo, created on first use; its events are sent again when the newest one is over `staleHours` old. */
export async function ensureDemo(opts: { now?: Date; staleHours?: number; deadline?: number } = {}): Promise<DemoRefs> {
  const now = opts.now ?? new Date();
  const refs = (await findDemo()) ?? (await createDemo());
  const newest = await withSystem((db) =>
    db.one<{ at: Date | null }>("select max(received_at) as at from platform.events where environment_id = $1", [refs.environmentId]),
  );
  const stale = !newest?.at || now.getTime() - new Date(newest.at).getTime() > (opts.staleHours ?? 6) * 3_600_000;
  if (stale) await sendDemoEvents(refs, now, opts.deadline);
  return refs;
}

async function sendDemoEvents(refs: DemoRefs, now: Date, deadline?: number) {
  const key = await withSystem((db) =>
    db.one<{ key: string }>(
      "select key from platform.sdk_keys where environment_id = $1 and status = 'active' and (expires_at is null or expires_at > now()) order by created_at limit 1",
      [refs.environmentId],
    ),
  );
  const principal = key && (await authenticateIngestionKey(key.key));
  if (!principal) throw new Error("The demo environment has no active SDK key.");
  const events = demoEvents(now);
  for (let i = 0; i < events.length; i += 500) {
    if (deadline && Date.now() > deadline) break;
    await ingest(principal, { batch: events.slice(i, i + 500) }, { mode: "batch", now });
  }
  await processPendingEvents({ environmentId: refs.environmentId, limit: 20_000, deadline });
}

/** A session for the demo Viewer (see /demo). */
export async function demoSession(refs: DemoRefs, userAgent: string | null) {
  return createSession(refs.viewerId, userAgent);
}

