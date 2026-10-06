import "server-only";
import { loadPublishedPlan } from "@/modules/implementation/plan-store";
import { validateEvent, type ValidationResult } from "@/modules/implementation/validate";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

export interface DebugEvent {
  id: string;
  event_id: string;
  type: string;
  event_name: string;
  canonical_name: string | null;
  timestamp: string;
  received_at: string;
  anonymous_id: string | null;
  user_id: string | null;
  session_id: string | null;
  platform: string | null;
  app_version: string | null;
  sdk: string | null;
  source: string;
  properties: Record<string, unknown>;
  user_properties: Record<string, unknown> | null;
  context: Record<string, unknown>;
  processed: boolean;
  /** null when no published plan covers this event. */
  validation: (ValidationResult & { planned: boolean }) | null;
}

/** Live feed for the event debugger: events after `afterId`, newest first. */
export function liveEvents(ctx: TenantContext, environmentId: string, opts: { afterId?: string; limit?: number } = {}): Promise<DebugEvent[]> {
  return tenantTx(ctx, "events.read", async (db) => {
    const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
    if (!env) return [];
    const rows = await db.query<{
      id: string; event_id: string; type: string; event_name: string; canonical_name: string | null; timestamp: Date; received_at: Date;
      anonymous_id: string | null; user_id: string | null; session_id: string | null; platform: string | null; app_version: string | null;
      sdk_name: string | null; sdk_version: string | null; source: string; properties: Record<string, unknown>;
      user_properties: Record<string, unknown> | null; context: Record<string, unknown>; processed_at: Date | null;
    }>(
      `select id, event_id, type, event_name, canonical_name, "timestamp", received_at, anonymous_id, user_id, session_id, platform,
              app_version, sdk_name, sdk_version, source, properties, user_properties, context, processed_at
         from platform.events
        where environment_id = $1 and ($2::bigint is null or id > $2::bigint)
        order by id desc limit $3`,
      [environmentId, opts.afterId && /^\d+$/.test(opts.afterId) ? opts.afterId : null, Math.min(opts.limit ?? 50, 200)],
    );
    const plan = await loadPublishedPlan(db, env.app_id);
    return rows.map((r) => {
      const canonical = plan?.mappings.get(r.event_name) ?? r.event_name;
      const spec = plan?.specs.get(canonical);
      return {
        id: r.id, event_id: r.event_id, type: r.type, event_name: r.event_name, canonical_name: canonical !== r.event_name ? canonical : null,
        timestamp: new Date(r.timestamp).toISOString(), received_at: new Date(r.received_at).toISOString(),
        anonymous_id: r.anonymous_id, user_id: r.user_id, session_id: r.session_id, platform: r.platform, app_version: r.app_version,
        sdk: r.sdk_name ? `${r.sdk_name} ${r.sdk_version ?? ""}`.trim() : null, source: r.source, properties: r.properties,
        user_properties: r.user_properties, context: r.context, processed: !!r.processed_at,
        validation: spec
          ? { ...validateEvent(spec, { properties: r.properties, user_id: r.user_id, user_properties: r.user_properties }), planned: true }
          : r.type === "identify"
            ? { ...validateEvent({ event_name: r.event_name, properties: [] }, { properties: {}, user_id: r.user_id, user_properties: r.user_properties }), planned: false }
            : plan?.specs.size
            ? { valid: true, errors: [], warnings: [{ code: "unknown_property", message: "Not in the published tracking plan" }], planned: false }
            : null,
      };
    });
  });
}

export interface ConnectionHealth {
  connected: boolean;
  lastEventAt: string | null;
  eventsToday: number;
  activeUsersToday: number;
  rejectedToday: number;
  /** Part of rejectedToday: valid events not stored because the user denied analytics consent (reason consent_denied). */
  consentDeniedToday: number;
  sdkVersions: { sdk: string; events: number }[];
  platforms: { platform: string; events: number }[];
  appVersions: { app_version: string; events: number }[];
}

export function connectionHealth(ctx: TenantContext, environmentId: string): Promise<ConnectionHealth> {
  return tenantTx(ctx, "events.read", async (db) => {
    const s = await db.one<{ last: Date | null; today: string; users: string }>(
      `select max(received_at) as last,
              count(*) filter (where received_at >= date_trunc('day', now())) as today,
              count(distinct coalesce(user_id, 'anon:' || anonymous_id)) filter (where received_at >= date_trunc('day', now())) as users
         from platform.events where environment_id = $1 and received_at > now() - interval '30 days'`,
      [environmentId],
    );
    const rejected = await db.one<{ n: string; consent: string }>(
      `select coalesce(sum(rejected_count), 0) as n, coalesce(sum(consent_denied_count), 0) as consent
         from platform.event_batches where environment_id = $1 and received_at >= date_trunc('day', now())`,
      [environmentId],
    );
    const breakdown = (col: string) =>
      db.query<{ k: string; n: string }>(
        `select coalesce(${col}, 'unknown') as k, count(*) as n from platform.events
          where environment_id = $1 and received_at > now() - interval '7 days' group by 1 order by 2 desc limit 8`,
        [environmentId],
      );
    // Sequential: one connection per transaction.
    const sdk = await breakdown("sdk_name || ' ' || coalesce(sdk_version, '')");
    const platforms = await breakdown("platform");
    const versions = await breakdown("app_version");
    return {
      connected: !!s?.last,
      lastEventAt: s?.last ? new Date(s.last).toISOString() : null,
      eventsToday: Number(s?.today ?? 0),
      activeUsersToday: Number(s?.users ?? 0),
      rejectedToday: Number(rejected?.n ?? 0),
      consentDeniedToday: Number(rejected?.consent ?? 0),
      sdkVersions: sdk.map((r) => ({ sdk: r.k, events: Number(r.n) })),
      platforms: platforms.map((r) => ({ platform: r.k, events: Number(r.n) })),
      appVersions: versions.map((r) => ({ app_version: r.k, events: Number(r.n) })),
    };
  });
}
