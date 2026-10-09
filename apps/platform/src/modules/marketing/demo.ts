import "server-only";
import { msg } from "@/i18n/translate";
import { createHash } from "node:crypto";
import { randomToken } from "@/lib/crypto";
import { withSystem } from "@/lib/db";
import { purgeReportCache } from "@/modules/analytics/cache";
import { localDate } from "@/modules/analytics/range";
import { createApp, getAppBySlug } from "@/modules/apps/service";
import { createSession, signUp } from "@/modules/auth/service";
import { authenticateIngestionKey } from "@/modules/credentials/service";
import { normalizeEvent, type NormalizedEvent } from "@/modules/ingestion/schema";
import { ingest } from "@/modules/ingestion/service";
import { createOrganization } from "@/modules/organizations/service";
import { processPendingEvents } from "@/modules/processing/processor";
import { resolveTenant } from "@/modules/tenancy/context";

/**
 * The public demo: an organization with one food-delivery app whose
 * production environment holds made-up activity: the last 30 days sent
 * through ingestion, and the journeys of people who installed up to 150 days
 * ago stored directly (ingestion refuses events that old), so Churn and RFM
 * segments have people who left and regulars who stayed. Anyone
 * can open it from the landing page (/demo) as a read-only Viewer; nothing in
 * it is real.
 *
 * It is on only when DEMO_ENABLED=1. The data is generated from a fixed seed,
 * so refreshing it re-sends the same events (ingestion drops duplicates by
 * event_id) plus the days that have passed since, which keeps the reports
 * current without growing. Installs carry the campaign parameters an SDK
 * captures, so attribution records them by source as it would real ones, and
 * the paid sources get daily ad spend (seedDemoSpend) for Acquisition's Ad
 * spend and CAC & LTV.
 */
export const DEMO_EMAIL = "demo@leanapp.io";
const OWNER_EMAIL = "demo-owner@leanapp.io";
export const DEMO_ORG_NAME = "Demo Foods";
export const DEMO_APP_NAME = "Food Express";
const DAYS = 30;
/** Installs this many days back have history (demoHistory), for Churn and RFM segments. */
const HISTORY_DAYS = 150;
const USERS_PER_DAY = 14;

export const demoEnabled = () => process.env.DEMO_ENABLED === "1";
/** What the demo account sees when it tries to change itself or create an organization. */
export const DEMO_LOCKED = msg("This is the shared demo account, so it can't be changed. Create your own account to try this.");
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

/** A uniform number in [0, 1) fixed by `key`. */
function unitHash(key: string): number {
  return parseInt(createHash("sha256").update(`leanapp-demo:${key}`).digest("hex").slice(0, 8), 16) / 2 ** 32;
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
 * The journeys of the people who installed in the last 30 days, as SDK
 * batches would send them: people install on a day (by acquisition source),
 * most sign up, and come back to order over the following days; some become
 * regulars who keep ordering about weekly for weeks or months. Each person's
 * journey is fixed by their day and number, whatever day it is generated on.
 */
export function demoEvents(now: Date): Record<string, unknown>[] {
  const today = Math.floor(now.getTime() / 86_400_000);
  return journeys(now, today - DAYS + 1, today);
}

/**
 * The journeys of the people who installed 31 to HISTORY_DAYS days ago (all of
 * their events, recent ones included), so Churn and RFM segments have history.
 * Ingestion takes nothing older than 31 days, so these are stored directly
 * (sendDemoHistory). A day that ages out of demoEvents keeps the same people
 * and event ids here, so nothing is ever sent twice.
 */
export function demoHistory(now: Date): Record<string, unknown>[] {
  const today = Math.floor(now.getTime() / 86_400_000);
  return journeys(now, today - HISTORY_DAYS + 1, today - DAYS);
}

/** The events (up to now) of the people who installed on days `first` to `last` (days since the epoch). */
function journeys(now: Date, first: number, last: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let day = first; day <= last; day++) {
    const dayRand = rng(day);
    const count = USERS_PER_DAY + Math.floor(dayRand() * 8) - 3;
    for (let n = 0; n < count; n++) {
      const r = rng(day * 1000 + n + 7);
      const id = `${day}-${n}`;
      // The source comes from a hash of the person, not from the generator's first draw: that
      // draw is nearly the same for everyone on a day (consecutive seeds), which gave one source
      // per day and left most sources out. The draw is still taken so the rest of each journey
      // stays as it was.
      r();
      const pick = unitHash(`source:${id}`);
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
        // Paid sources carry their campaign; organic Android installs carry the Play Store's own
        // organic referrer (store discovery). Organic iOS installs carry nothing: unattributed.
        ...(src.source
          ? { attribution: { utm_source: src.source, utm_medium: "paid", utm_campaign: src.campaign } }
          : platform === "android" ? { attribution: { utm_source: "google-play", utm_medium: "organic" } } : {}),
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
      // Regulars come after the rest of the journey, so the events above keep their ids. Most
      // Plus members and a few others order about weekly for 2 to 17 weeks, then stop.
      if (r() > (plan === "plus" ? 0.55 : 0.15)) continue;
      const weeks = 2 + Math.floor(r() * 16);
      const basket = plan === "plus" ? 60 : 35;
      for (let w = 0; w < weeks; w++) {
        t += (4 + Math.floor(r() * 7)) * 86_400_000 + Math.floor(r() * 5) * 3_600_000;
        push({ type: "track", event_name: "app_opened", user_id: uid });
        const cuisine = CUISINES[Math.floor(r() * CUISINES.length)];
        if (r() > 0.8) continue;
        push({
          type: "track",
          event_name: "order_completed",
          user_id: uid,
          properties: { order_id: `o-${id}-w${w}`, revenue: basket + Math.floor(r() * 90), currency: "SAR", payment_method: r() < 0.6 ? "card" : "cash", cuisine },
        });
      }
    }
  }
  return out;
}

/**
 * What the demo's paid sources cost per install, in the app's currency (SAR), before a daily
 * swing of up to ±25%.
 */
const COST_PER_INSTALL: Record<string, number> = { tiktok: 14, snapchat: 17, google: 26, meta: 21 };
/** Spend older than this many days is dropped, so the demo doesn't grow. */
const SPEND_KEEP_DAYS = 90;

/**
 * The demo's ad spend (Acquisition → Ad spend, CAC & LTV): for each app-local day of the last
 * DAYS days and each paid source, the installs attribution recorded that day × the source's
 * cost per install, with a fixed daily swing. Being derived from the recorded installs, it also
 * fills in a demo whose events were sent before spend was seeded, and follows a day's installs
 * as they arrive. Saving the same amounts again changes nothing. Returns the rows written.
 */
export async function seedDemoSpend(refs: DemoRefs, now: Date): Promise<number> {
  return withSystem(async (db) => {
    const app = await db.one<{ organization_id: string; timezone: string; currency: string }>(
      `select a.organization_id, a.timezone, a.default_currency as currency
         from platform.environments e join platform.apps a on a.id = e.app_id where e.id = $1`,
      [refs.environmentId],
    );
    if (!app) return 0;
    // The last DAYS days in the app's timezone, today first.
    const days = Array.from({ length: DAYS }, (_, i) => localDate(new Date(now.getTime() - i * 86_400_000), app.timezone));
    const today = days[0];
    const installs = await db.query<{ day: string; source: string; n: number }>(
      `select (occurred_at at time zone $2)::date::text as day, source, count(*)::int as n
         from platform.attribution_events
        where environment_id = $1 and kind in ('install', 'reinstall') and source = any($3::text[])
          and occurred_at >= $4 and (occurred_at at time zone $2)::date between $5::date and $6::date
        group by 1, 2`,
      [refs.environmentId, app.timezone, Object.keys(COST_PER_INSTALL), new Date(now.getTime() - (DAYS + 2) * 86_400_000), days[DAYS - 1], today],
    );
    const count = new Map(installs.map((r) => [`${r.day}|${r.source}`, r.n]));
    // Campaigns run every day, including days that brought no install (then half an install's cost).
    const rows = days.flatMap((day) =>
      Object.entries(COST_PER_INSTALL).map(([source, cost]) => ({
        day,
        source,
        campaign: SOURCES.find((s) => s.source === source)?.campaign ?? "",
        amount: Math.round(Math.max(count.get(`${day}|${source}`) ?? 0, 0.5) * cost * (0.75 + 0.5 * unitHash(`spend:${day}:${source}`)) * 100) / 100,
      })),
    );
    const written = await db.query(
      `insert into platform.ad_spend_daily (organization_id, environment_id, day, source, campaign, currency, amount)
       select $1, $2, r.day, r.source, r.campaign, $3, r.amount
         from unnest($4::date[], $5::text[], $6::text[], $7::numeric[]) as r(day, source, campaign, amount)
       on conflict (environment_id, day, source, campaign, currency)
       do update set amount = excluded.amount where ad_spend_daily.amount is distinct from excluded.amount
       returning 1`,
      [app.organization_id, refs.environmentId, app.currency, rows.map((r) => r.day), rows.map((r) => r.source), rows.map((r) => r.campaign), rows.map((r) => r.amount)],
    );
    const dropped = await db.query("delete from platform.ad_spend_daily where environment_id = $1 and day < $2::date - $3::int returning 1", [
      refs.environmentId,
      today,
      SPEND_KEEP_DAYS,
    ]);
    // The reports cache results: drop them so the new spend shows at once.
    if (written.length || dropped.length) await purgeReportCache(db, refs.environmentId);
    return written.length;
  });
}

/**
 * The demo, created on first use; its events are sent again when the newest one is over
 * `staleHours` old. Its ad spend is brought in line with its installs on every call (cheap; it
 * also fills in a demo created before spend was seeded).
 */
export async function ensureDemo(opts: { now?: Date; staleHours?: number; deadline?: number } = {}): Promise<DemoRefs> {
  const now = opts.now ?? new Date();
  const refs = (await findDemo()) ?? (await createDemo());
  const newest = await withSystem((db) =>
    db.one<{ at: Date | null }>("select max(received_at) as at from platform.events where environment_id = $1", [refs.environmentId]),
  );
  const stale = !newest?.at || now.getTime() - new Date(newest.at).getTime() > (opts.staleHours ?? 6) * 3_600_000;
  if (stale) await sendDemoEvents(refs, now, opts.deadline);
  await seedDemoSpend(refs, now);
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
  await sendDemoHistory(refs, now, deadline);
  // History adds up to a few tens of thousands of events on a new demo; the worker finishes what doesn't fit.
  await processPendingEvents({ environmentId: refs.environmentId, limit: 20_000, deadline });
}

/**
 * Stores demoHistory's events directly, as ingestion would have stored them
 * when they happened (each is checked as if it had arrived a minute after
 * it happened). Events already stored are skipped by event_id. Returns how
 * many were added; processing picks them up like any other.
 */
export async function sendDemoHistory(refs: DemoRefs, now: Date, deadline?: number): Promise<number> {
  const rows: NormalizedEvent[] = [];
  for (const raw of demoHistory(now)) {
    const r = normalizeEvent(raw, { now: new Date(Date.parse(raw.timestamp as string) + 60_000), fallbackEventId: () => String(raw.event_id) });
    if (r.ok) rows.push(r.event);
  }
  let added = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    if (deadline && Date.now() > deadline) break;
    added += await withSystem(async (db) => {
      const stored = await db.query(
        `insert into platform.events
           (organization_id, app_id, environment_id, event_id, type, event_name, "timestamp", received_at,
            anonymous_id, user_id, session_id, platform, app_version, os_version, sdk_name, sdk_version,
            source, schema_version, properties, user_properties, context)
         select env.organization_id, env.app_id, env.id, e.event_id, e.type, e.event_name, e.ts, now(),
                e.anonymous_id, e.user_id, e.session_id, e.platform, e.app_version, e.os_version, e.sdk_name, e.sdk_version,
                'mobile_sdk', e.schema_version, e.properties, e.user_properties, e.context
           from platform.environments env,
                jsonb_to_recordset($2::jsonb) as e(
                  event_id text, type text, event_name text, ts timestamptz, anonymous_id text, user_id text,
                  session_id text, platform text, app_version text, os_version text, sdk_name text, sdk_version text,
                  schema_version int, properties jsonb, user_properties jsonb, context jsonb)
          where env.id = $1
         on conflict (environment_id, event_id) do nothing
         returning 1`,
        [refs.environmentId, JSON.stringify(rows.slice(i, i + 2000).map((e) => ({ ...e, ts: e.timestamp })))],
      );
      return stored.length;
    });
  }
  return added;
}

/** A session for the demo Viewer (see /demo). */
export async function demoSession(refs: DemoRefs, userAgent: string | null) {
  return createSession(refs.viewerId, userAgent);
}

