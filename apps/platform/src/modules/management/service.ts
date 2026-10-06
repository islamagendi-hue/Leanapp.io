import "server-only";
import { z } from "zod";
import { withTenant, type Db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { eventTrend, topEvents, type EventTotal, type Trend } from "@/modules/analytics/service";
import type { IngestionPrincipal } from "@/modules/credentials/service";
import type { TenantContext } from "@/modules/tenancy/context";

/**
 * Read side of the public management API. Everything is scoped to the secret
 * key: its organization (RLS), its app and its environment. A key never sees
 * another environment's data, even of the same app.
 */

export type ManagementKey = Pick<IngestionPrincipal, "keyId" | "organizationId" | "appId" | "environmentId">;

function tx<T>(key: ManagementKey, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTenant({ organizationId: key.organizationId, userId: null }, fn);
}

export interface ApiEnvironment {
  id: string;
  name: string;
  type: "development" | "staging" | "production";
  status: string;
  created_at: Date;
}

export interface ApiApp {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  timezone: string;
  default_currency: string;
  platforms: string[];
  created_at: Date;
}

const ENV_COLUMNS = "id, name, type, status, created_at";

export function getKeyEnvironment(key: ManagementKey): Promise<ApiEnvironment> {
  return tx(key, async (db) => {
    const env = await db.one<ApiEnvironment>(`select ${ENV_COLUMNS} from platform.environments where id = $1 and app_id = $2`, [key.environmentId, key.appId]);
    if (!env) throw new NotFoundError("Environment");
    return env;
  });
}

/** The key's app, with the key's environment (and only that one). */
export function getKeyApp(key: ManagementKey): Promise<ApiApp & { environment: ApiEnvironment }> {
  return tx(key, async (db) => {
    const app = await db.one<ApiApp>(
      `select a.id, a.name, a.slug, a.description, a.category, a.timezone, a.default_currency, a.created_at,
              coalesce((select array_agg(p.platform order by p.platform) from platform.app_platforms p where p.app_id = a.id), '{}') as platforms
         from platform.apps a where a.id = $1`,
      [key.appId],
    );
    const env = await db.one<ApiEnvironment>(`select ${ENV_COLUMNS} from platform.environments where id = $1 and app_id = $2`, [key.environmentId, key.appId]);
    if (!app || !env) throw new NotFoundError("App");
    return { ...app, environment: env };
  });
}

export interface ApiUser {
  user_id: string;
  properties: Record<string, unknown>;
  first_seen_at: Date;
  last_seen_at: Date;
  anonymous_ids: string[];
  event_count: number;
  last_event_at: Date | null;
}

const userIdSchema = z.string().trim().min(1, "user_id is required.").max(256, "user_id is too long.");

/** An end user of the key's environment by the app's own user_id. */
export function lookupUser(key: ManagementKey, rawUserId: unknown): Promise<ApiUser> {
  const r = userIdSchema.safeParse(rawUserId);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid user_id.");
  const userId = r.data;
  return tx(key, async (db) => {
    const u = await db.one<{ external_id: string; properties: Record<string, unknown>; first_seen_at: Date; last_seen_at: Date }>(
      "select external_id, properties, first_seen_at, last_seen_at from platform.app_users where environment_id = $1 and external_id = $2",
      [key.environmentId, userId],
    );
    if (!u) throw new NotFoundError("User");
    const links = await db.query<{ anonymous_id: string }>(
      "select anonymous_id from platform.identity_links where environment_id = $1 and user_id = $2 order by last_seen_at desc limit 100",
      [key.environmentId, userId],
    );
    const ev = await db.one<{ n: string; last: Date | null }>(
      "select count(*) as n, max(\"timestamp\") as last from platform.events where environment_id = $1 and user_id = $2",
      [key.environmentId, userId],
    );
    return {
      user_id: u.external_id,
      properties: u.properties,
      first_seen_at: u.first_seen_at,
      last_seen_at: u.last_seen_at,
      anonymous_ids: links.map((l) => l.anonymous_id),
      event_count: Number(ev?.n ?? 0),
      last_event_at: ev?.last ?? null,
    };
  });
}

/**
 * The analytics service authorizes dashboard members by role. A key with
 * `analytics:read` gets exactly the read access of the analyst role's
 * `analytics.read` permission, in its own organization, with no user.
 */
function analyticsContext(key: ManagementKey): TenantContext {
  return { organizationId: key.organizationId, organizationSlug: "", organizationName: "", userId: "", role: "analyst" };
}

export interface EventsReport {
  environment_id: string;
  days: number;
  events: EventTotal[];
}

export async function eventsReport(key: ManagementKey, days: unknown): Promise<EventsReport> {
  const d = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  return { environment_id: key.environmentId, days: d, events: await topEvents(analyticsContext(key), { environmentId: key.environmentId, days: d }) };
}

export async function eventTrendReport(key: ManagementKey, input: { event?: unknown; days?: unknown; breakdown?: unknown }): Promise<Trend & { environment_id: string; timezone: string }> {
  const app = await tx(key, (db) => db.one<{ timezone: string }>("select timezone from platform.apps where id = $1", [key.appId]));
  if (!app) throw new NotFoundError("App");
  const trend = await eventTrend(analyticsContext(key), { environmentId: key.environmentId, timezone: app.timezone }, input);
  return { environment_id: key.environmentId, timezone: app.timezone, ...trend };
}
