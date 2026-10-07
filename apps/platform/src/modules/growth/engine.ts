import "server-only";
import type { Db } from "@/lib/db";
import { loadPlanEvents } from "@/modules/implementation/plan-store";
import { effectiveDefinition, type GrowthDefinition } from "./definition";
import { ACTIVE_TYPES, applyEventSql, rebuildSelectSql } from "./sql";

/**
 * Growth state maintenance (system scope; used by event processing and the
 * rebuild job). Only runs for apps with the growth_model feature on.
 *
 * Per processed event (processor step 6, after the event is marked processed):
 *   - a new identity link (identify) moves the install's anonymous events to
 *     the user (or back, when the install becomes shared), so every person it
 *     touches is rebuilt from their events;
 *   - otherwise the event is applied to its person's row with min / max / sum
 *     updates, or the person is rebuilt when there is no row yet or the event
 *     is earlier than everything seen so far (late or out-of-order events).
 * Rebuilds are set-based over the person's own events, so the result is
 * always the same as recomputing from scratch.
 */

export interface GrowthConfig {
  appId: string;
  versionId: string | null;
  definition: GrowthDefinition;
  defaultCurrency: string;
  apply: { sql: string; extra: unknown[] };
  rebuild: { sql: string; extra: unknown[] };
}

/** The app's growth configuration, or null when growth_model is off. */
export async function growthConfig(db: Db, appId: string): Promise<GrowthConfig | null> {
  const row = await db.one<{
    features: Record<string, unknown>;
    default_currency: string;
    version_id: string | null;
    growth: unknown;
    activation_event: string | null;
    north_star_event: string | null;
  }>(
    `select a.features, a.default_currency, v.id as version_id, v.growth, v.activation_event, v.north_star_event
       from platform.apps a
       left join platform.tracking_plans p on p.app_id = a.id
       left join platform.tracking_plan_versions v on v.id = p.published_version_id
      where a.id = $1`,
    [appId],
  );
  if (!row || row.features?.growth_model !== true) return null;
  const events = row.version_id ? await loadPlanEvents(db, row.version_id) : [];
  const definition = effectiveDefinition(row.version_id ? row : null, events);
  return compileConfig(appId, row.version_id, definition, row.default_currency);
}

export function compileConfig(appId: string, versionId: string | null, definition: GrowthDefinition, defaultCurrency: string): GrowthConfig {
  const apply = applyEventSql(definition, defaultCurrency);
  const rebuild = rebuildSelectSql(definition, defaultCurrency);
  return {
    appId,
    versionId,
    definition,
    defaultCurrency,
    apply: { sql: apply.sql, extra: apply.params.values.slice(4) },
    rebuild: { sql: rebuild.sql, extra: rebuild.params.values.slice(5) },
  };
}

/** Recomputes (or removes) the growth_state rows of these people from all their events. */
export async function rebuildPersons(db: Db, cfg: GrowthConfig, environmentId: string, persons: string[]): Promise<number> {
  const unique = [...new Set(persons.filter(Boolean))];
  if (!unique.length) return 0;
  const users = unique.filter((p) => !p.startsWith("anon:"));
  const anons = unique.filter((p) => p.startsWith("anon:")).map((p) => p.slice(5));
  if (users.length) {
    // The installs linked to these users: their anonymous events may belong to them.
    const linked = await db.query<{ anonymous_id: string }>(
      "select distinct anonymous_id from platform.identity_links where environment_id = $1 and user_id = any($2::text[])",
      [environmentId, users],
    );
    anons.push(...linked.map((r) => r.anonymous_id));
  }
  const r = await db.one<{ upserted: string; deleted: string }>(
    `with r as (${cfg.rebuild.sql}),
     env as (select organization_id, app_id from platform.environments where id = $1),
     up as (
       insert into platform.growth_state as g
         (organization_id, app_id, environment_id, person, user_id, anonymous_id, first_seen_at, last_active_at, activated_at,
          first_core_action_at, core_action_count, first_revenue_at, revenue, purchases, retained_d1_at, retained_d7_at, retained_d30_at,
          plan_version_id, updated_at)
       select env.organization_id, env.app_id, $1, r.person, r.user_id, r.anonymous_id, r.first_seen_at, r.last_active_at, r.activated_at,
              r.first_core_action_at, r.core_action_count, r.first_revenue_at, r.revenue, r.purchases, r.retained_d1_at, r.retained_d7_at,
              r.retained_d30_at, r.plan_version_id, now()
         from r, env
       on conflict (environment_id, person) do update set
         user_id = excluded.user_id, anonymous_id = excluded.anonymous_id, first_seen_at = excluded.first_seen_at,
         last_active_at = excluded.last_active_at, activated_at = excluded.activated_at,
         first_core_action_at = excluded.first_core_action_at, core_action_count = excluded.core_action_count,
         first_revenue_at = excluded.first_revenue_at, revenue = excluded.revenue, purchases = excluded.purchases,
         retained_d1_at = excluded.retained_d1_at, retained_d7_at = excluded.retained_d7_at, retained_d30_at = excluded.retained_d30_at,
         plan_version_id = excluded.plan_version_id, updated_at = now()
       returning g.person),
     gone as (
       delete from platform.growth_state g
        where g.environment_id = $1 and g.person = any($2::text[]) and g.person not in (select person from r)
       returning 1)
     select (select count(*) from up) as upserted, (select count(*) from gone) as deleted`,
    [environmentId, unique, users, [...new Set(anons)], cfg.versionId, ...cfg.rebuild.extra],
  );
  return Number(r?.upserted ?? 0) + Number(r?.deleted ?? 0);
}

export interface GrowthEvent {
  id: string;
  environment_id: string;
  type: string;
  anonymous_id: string | null;
  user_id: string | null;
}

/** Processor step 6. `newLink`: this event created an identity link. */
export async function updateGrowthForEvent(db: Db, cfg: GrowthConfig, e: GrowthEvent, newLink: boolean): Promise<void> {
  if (newLink && e.anonymous_id) {
    // Everyone whose events the new link can move: the user, the install itself,
    // and every user the install is linked to (a second link makes it shared).
    const linked = await db.query<{ user_id: string }>(
      "select user_id from platform.identity_links where environment_id = $1 and anonymous_id = $2",
      [e.environment_id, e.anonymous_id],
    );
    await rebuildPersons(db, cfg, e.environment_id, [`anon:${e.anonymous_id}`, ...(e.user_id ? [e.user_id] : []), ...linked.map((l) => l.user_id)]);
    return;
  }
  if (!(ACTIVE_TYPES as readonly string[]).includes(e.type)) return;
  let person = e.user_id;
  if (!person && e.anonymous_id) {
    const single = await db.one<{ user_id: string }>(
      "select min(user_id) as user_id from platform.identity_links where environment_id = $1 and anonymous_id = $2 having count(*) = 1",
      [e.environment_id, e.anonymous_id],
    );
    person = single?.user_id ?? `anon:${e.anonymous_id}`;
  }
  if (!person) return;
  const applied = await db.query(cfg.apply.sql, [e.environment_id, person, e.id, cfg.versionId, ...cfg.apply.extra]);
  if (!applied.length) await rebuildPersons(db, cfg, e.environment_id, [person]);
}
