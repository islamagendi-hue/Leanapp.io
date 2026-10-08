import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy/context";
import { loadRevenueRules, NO_CURRENCY, revenueCtes } from "./revenue";
import { analyticsTx, audienceSql } from "./service";
import { propertyFilterSchema, propertyPredicate, type PropertyFilter } from "@/modules/audiences/definition";
import { Params } from "./sql";

/**
 * End-user profiles: search an environment's people by user id or anonymous
 * id, and show one person with their stitched installs, properties, activity
 * and revenue. Needs `users.read`.
 *
 * Identity follows the reports: a user's person includes the anonymous
 * activity of installs linked to that user only. An install linked to several
 * users (a shared device) is listed on each of those profiles but its
 * anonymous events stay with the install, never merged into any one user.
 */

const PERMISSION = "users.read" as const;
const idSchema = z.string().trim().min(1).max(256);

export type PersonRef = { userId: string } | { anonymousId: string };

export interface SearchResult {
  users: { userId: string; firstSeen: Date; lastSeen: Date; properties: Record<string, unknown> }[];
  installs: { anonymousId: string; platform: string | null; firstSeen: Date; lastSeen: Date; linkedUsers: string[] }[];
}

const likePrefix = (q: string) => `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const MAX_USER_FILTERS = 3;
export const MAX_USER_COLUMNS = 5;

export interface SearchOptions {
  limit?: number;
  /** User property filters (catalog properties); all must match. */
  filters?: PropertyFilter[];
  /** User properties to return with each user. */
  columns?: string[];
  /** Only members of this audience (computed now, like a report filter). */
  audienceId?: string;
  /** The project's timezone, for audiences with date ranges. */
  timezone?: string;
}

/**
 * Users and installs whose id starts with `q` (exact matches first); recently
 * seen users when `q` is empty. Property filters and an audience narrow the
 * users (installs have no user properties, so they're left out when filtering).
 */
export async function searchPeople(ctx: TenantContext, environmentId: string, q: unknown, opts: SearchOptions = {}): Promise<SearchResult> {
  const query = typeof q === "string" ? q.trim().slice(0, 256) : "";
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const filters = (opts.filters ?? []).slice(0, MAX_USER_FILTERS).map((f) => {
    const r = propertyFilterSchema.safeParse(f);
    if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid filter.");
    return r.data;
  });
  const columns = [...new Set(opts.columns ?? [])].filter((c) => /^[A-Za-z0-9_$][A-Za-z0-9_.$-]{0,63}$/.test(c)).slice(0, MAX_USER_COLUMNS);
  return analyticsTx(
    ctx,
    async (db) => {
      const p = new Params([environmentId]);
      const where = [`u.environment_id = $1`];
      const audience = opts.audienceId ? await audienceSql(db, { environmentId, timezone: opts.timezone }, opts.audienceId, p) : null;
      if (audience) where.push("u.external_id in (select person from audience)");
      if (query) where.push(`u.external_id like ${p.add(likePrefix(query))}`);
      for (const f of filters) where.push(propertyPredicate("u.properties", f, p));
      const props = columns.length
        ? `coalesce((select jsonb_object_agg(k.key, k.value) from jsonb_each(u.properties) k where k.key = any(${p.add(columns)}::text[])), '{}'::jsonb)`
        : `'{}'::jsonb`;
      const order = query ? `u.external_id = ${p.add(query)} desc, u.last_seen_at desc` : "u.last_seen_at desc, u.external_id";
      const users = await db.query<{ external_id: string; first_seen_at: Date; last_seen_at: Date; props: Record<string, unknown> }>(
        `${audience ? `with audience as (${audience}) ` : ""}select u.external_id, u.first_seen_at, u.last_seen_at, ${props} as props from platform.app_users u
          where ${where.join(" and ")}
          order by ${order} limit ${p.add(limit)}`,
        p.values,
      );
      const result: SearchResult = {
        users: users.map((u) => ({ userId: u.external_id, firstSeen: u.first_seen_at, lastSeen: u.last_seen_at, properties: u.props })),
        installs: [],
      };
      if (!query || filters.length || audience) return result;
      const installs = await db.query<{ anonymous_id: string; platform: string | null; first_seen_at: Date; last_seen_at: Date; linked: string[] }>(
        `select a.anonymous_id, a.platform, a.first_seen_at, a.last_seen_at,
                coalesce((select array_agg(il.user_id order by il.user_id) from platform.identity_links il
                           where il.environment_id = a.environment_id and il.anonymous_id = a.anonymous_id), '{}') as linked
           from platform.anonymous_users a
          where a.environment_id = $1 and a.anonymous_id like $2
          order by a.anonymous_id = $3 desc, a.last_seen_at desc limit $4`,
        [environmentId, likePrefix(query), query, limit],
      );
      result.installs = installs.map((a) => ({ anonymousId: a.anonymous_id, platform: a.platform, firstSeen: a.first_seen_at, lastSeen: a.last_seen_at, linkedUsers: a.linked }));
      return result;
    },
    PERMISSION,
  );
}

export interface Install {
  anonymousId: string;
  platform: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  /** Every user this install was linked to. */
  linkedUsers: string[];
  /** Its anonymous activity belongs to this person (linked to exactly one user). */
  stitched: boolean;
}

export interface Profile {
  /** The person key used by reports and cohorts: the user id, or `anon:<anonymous id>`. */
  person: string;
  userId: string | null;
  anonymousId: string | null;
  properties: Record<string, unknown>;
  installs: Install[];
  firstSeen: Date | null;
  lastSeen: Date | null;
  platform: string | null;
  appVersion: string | null;
  osVersion: string | null;
  eventCount: number;
  sessionCount: number;
  revenue: { currency: string; net: number; gross: number; refunds: number; transactions: number }[];
}

export type ProfileResult = Profile | { redirectToUser: string };

/** Who a person is, as a predicate on platform.events `e` ($1 environment). */
interface Who {
  person: string;
  userId: string | null;
  anonymousId: string | null;
  installs: Install[];
  /** Installs whose anonymous events count as this person. */
  stitched: string[];
}

async function resolve(db: Db, environmentId: string, ref: PersonRef): Promise<Who | { redirectToUser: string } | null> {
  if ("userId" in ref) {
    const userId = idSchema.parse(ref.userId);
    const installs = await db.query<{ anonymous_id: string; platform: string | null; first_seen_at: Date | null; last_seen_at: Date | null; linked: string[] }>(
      `select il.anonymous_id, a.platform, a.first_seen_at, a.last_seen_at,
              (select array_agg(x.user_id order by x.user_id) from platform.identity_links x
                where x.environment_id = il.environment_id and x.anonymous_id = il.anonymous_id) as linked
         from platform.identity_links il
         left join platform.anonymous_users a on a.environment_id = il.environment_id and a.anonymous_id = il.anonymous_id
        where il.environment_id = $1 and il.user_id = $2
        order by a.last_seen_at desc nulls last, il.anonymous_id`,
      [environmentId, userId],
    );
    const exists = await db.one("select 1 from platform.app_users where environment_id = $1 and external_id = $2", [environmentId, userId]);
    if (!exists && installs.length === 0) return null;
    const list = installs.map((i) => ({
      anonymousId: i.anonymous_id, platform: i.platform, firstSeen: i.first_seen_at, lastSeen: i.last_seen_at,
      linkedUsers: i.linked, stitched: i.linked.length === 1,
    }));
    return { person: userId, userId, anonymousId: null, installs: list, stitched: list.filter((i) => i.stitched).map((i) => i.anonymousId) };
  }
  const anonymousId = idSchema.parse(ref.anonymousId);
  const links = await db.query<{ user_id: string }>(
    "select user_id from platform.identity_links where environment_id = $1 and anonymous_id = $2 order by user_id",
    [environmentId, anonymousId],
  );
  if (links.length === 1) return { redirectToUser: links[0].user_id };
  const a = await db.one<{ platform: string | null; first_seen_at: Date; last_seen_at: Date }>(
    "select platform, first_seen_at, last_seen_at from platform.anonymous_users where environment_id = $1 and anonymous_id = $2",
    [environmentId, anonymousId],
  );
  if (!a && links.length === 0) return null;
  const install: Install = {
    anonymousId, platform: a?.platform ?? null, firstSeen: a?.first_seen_at ?? null, lastSeen: a?.last_seen_at ?? null,
    linkedUsers: links.map((l) => l.user_id), stitched: true,
  };
  return { person: `anon:${anonymousId}`, userId: null, anonymousId, installs: [install], stitched: [anonymousId] };
}

/** Predicate selecting the person's events; adds its values to `p` ($1 is the environment). */
function eventsOf(who: Who, p: Params): string {
  const stitched = `(e.user_id is null and e.anonymous_id = any(${p.add(who.stitched)}::text[]))`;
  return who.userId ? `(e.user_id = ${p.add(who.userId)} or ${stitched})` : stitched;
}

export async function getProfile(ctx: TenantContext, scope: { environmentId: string }, ref: PersonRef): Promise<ProfileResult> {
  return analyticsTx(
    ctx,
    async (db) => {
      const who = await resolve(db, scope.environmentId, ref).catch((e) => {
        if (e instanceof z.ZodError) throw new ValidationError("Enter a user ID or an anonymous ID.");
        throw e;
      });
      if (!who) throw new NotFoundError("Person");
      if ("redirectToUser" in who) return who;

      const props = who.userId
        ? await db.one<{ properties: Record<string, unknown> }>(
            "select properties from platform.app_users where environment_id = $1 and external_id = $2", [scope.environmentId, who.userId])
        : await db.one<{ properties: Record<string, unknown> }>(
            "select coalesce(first_context->'traits', '{}'::jsonb) as properties from platform.anonymous_users where environment_id = $1 and anonymous_id = $2",
            [scope.environmentId, who.anonymousId]);

      let p = new Params([scope.environmentId]);
      let pred = eventsOf(who, p);
      const stats = await db.one<{ first: Date | null; last: Date | null; n: string }>(
        `select min(e."timestamp") as first, max(e."timestamp") as last, count(*) filter (where e.type = 'track') as n
           from platform.events e where e.environment_id = $1 and ${pred}`,
        p.values,
      );
      const device = await db.one<{ platform: string | null; app_version: string | null; os_version: string | null }>(
        `select e.platform, e.app_version, e.os_version from platform.events e
          where e.environment_id = $1 and ${pred} and (e.platform is not null or e.app_version is not null)
          order by e."timestamp" desc, e.id desc limit 1`,
        p.values,
      );
      const sessionPred = who.userId
        ? "(s.user_id = $2 or (s.user_id is null and s.anonymous_id = any($3::text[])))"
        : "(s.user_id is null and s.anonymous_id = any($2::text[]))";
      const sessions = await db.one<{ n: string }>(
        `select count(*) as n from platform.sessions s where s.environment_id = $1 and ${sessionPred}`,
        who.userId ? [scope.environmentId, who.userId, who.stitched] : [scope.environmentId, who.stitched],
      );

      const rules = await loadRevenueRules(db, scope.environmentId);
      p = new Params([scope.environmentId]);
      pred = eventsOf(who, p);
      const personParam = p.add(who.person);
      const revenue = await db.query<{ currency: string; kind: string; amount: number; n: string }>(
        `with ev as (
           select coalesce(e.canonical_name, e.event_name) as name, ${personParam}::text as person, e."timestamp" as ts, e.id, e.platform, e.properties
             from platform.events e where e.environment_id = $1 and e.type = 'track' and ${pred}
         ), ${revenueCtes(p, rules)}
         select currency, kind, sum(amount)::float8 as amount, count(*) as n from tx group by currency, kind`,
        p.values,
      );
      const byCurrency = new Map<string, Profile["revenue"][number]>();
      for (const r of revenue) {
        const c = r.currency ?? NO_CURRENCY;
        if (!byCurrency.has(c)) byCurrency.set(c, { currency: c, net: 0, gross: 0, refunds: 0, transactions: 0 });
        const t = byCurrency.get(c)!;
        if (r.kind === "refund") t.refunds += Number(r.amount);
        else {
          t.gross += Number(r.amount);
          t.transactions += Number(r.n);
        }
      }
      const round = (n: number) => Math.round(n * 100) / 100;

      return {
        person: who.person,
        userId: who.userId,
        anonymousId: who.anonymousId,
        properties: props?.properties ?? {},
        installs: who.installs,
        firstSeen: stats?.first ?? null,
        lastSeen: stats?.last ?? null,
        platform: device?.platform ?? null,
        appVersion: device?.app_version ?? null,
        osVersion: device?.os_version ?? null,
        eventCount: Number(stats?.n ?? 0),
        sessionCount: Number(sessions?.n ?? 0),
        revenue: [...byCurrency.values()]
          .map((t) => ({ ...t, gross: round(t.gross), refunds: round(t.refunds), net: round(t.gross - t.refunds) }))
          .sort((a, b) => b.transactions - a.transactions),
      };
    },
    PERMISSION,
  );
}

export interface TimelineEvent {
  id: string;
  type: string;
  name: string;
  /** As sent, when an accepted mapping renamed it. */
  sentAs: string | null;
  timestamp: Date;
  platform: string | null;
  appVersion: string | null;
  anonymousId: string | null;
  userId: string | null;
  sessionId: string | null;
  properties: Record<string, unknown>;
}

export const TIMELINE_PAGE = 50;

/** Cursor: `<epoch microseconds>.<id>` of the last event of the previous page (microseconds: Postgres precision). */
function parseCursor(c: unknown): { us: string; id: string } | null {
  if (typeof c !== "string") return null;
  const m = /^(\d{1,17})\.(\d{1,19})$/.exec(c);
  return m ? { us: m[1], id: m[2] } : null;
}
const MICROS = `(floor(extract(epoch from e."timestamp") * 1000000))::bigint`;

/** The person's events, newest first, `TIMELINE_PAGE` at a time (keyset paging). Push-token events are left out. */
export async function profileTimeline(
  ctx: TenantContext,
  scope: { environmentId: string },
  ref: PersonRef,
  opts: { cursor?: unknown; limit?: number } = {},
): Promise<{ events: TimelineEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? TIMELINE_PAGE, 1), 200);
  const cursor = parseCursor(opts.cursor);
  return analyticsTx(
    ctx,
    async (db) => {
      const who = await resolve(db, scope.environmentId, ref).catch((e) => {
        if (e instanceof z.ZodError) throw new ValidationError("Enter a user ID or an anonymous ID.");
        throw e;
      });
      if (!who || "redirectToUser" in who) throw new NotFoundError("Person");
      const p = new Params([scope.environmentId]);
      const pred = eventsOf(who, p);
      const after = cursor ? `and (${MICROS}, e.id) < (${p.add(cursor.us)}::bigint, ${p.add(cursor.id)}::bigint)` : "";
      const rows = await db.query<{
        id: string; us: string; type: string; event_name: string; canonical_name: string | null; timestamp: Date; platform: string | null; app_version: string | null;
        anonymous_id: string | null; user_id: string | null; session_id: string | null; properties: Record<string, unknown>;
      }>(
        `select e.id, ${MICROS} as us, e.type, e.event_name, e.canonical_name, e."timestamp", e.platform, e.app_version, e.anonymous_id, e.user_id, e.session_id, e.properties
           from platform.events e
          where e.environment_id = $1 and e.type <> 'push_token' and ${pred} ${after}
          order by e."timestamp" desc, e.id desc limit ${p.add(limit + 1)}`,
        p.values,
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        events: page.map((r) => ({
          id: String(r.id), type: r.type, name: r.canonical_name ?? r.event_name, sentAs: r.canonical_name && r.canonical_name !== r.event_name ? r.event_name : null,
          timestamp: r.timestamp, platform: r.platform, appVersion: r.app_version, anonymousId: r.anonymous_id, userId: r.user_id,
          sessionId: r.session_id, properties: r.properties,
        })),
        nextCursor: rows.length > limit && last ? `${last.us}.${last.id}` : null,
      };
    },
    PERMISSION,
  );
}
