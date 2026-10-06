import "server-only";
import type { Db } from "@/lib/db";
import type { PropertyType } from "./catalog/properties";
import type { EventSpec } from "./validate";

export interface PlanEventRow {
  id: string;
  event_name: string;
  display_name: string;
  description: string;
  category: string;
  trigger: string;
  source: "mobile_sdk" | "backend" | "both" | "automatic";
  priority: "critical" | "high" | "medium" | "low";
  required: boolean;
  activation_relevance: boolean;
  conversion_relevance: boolean;
  revenue_relevance: boolean;
  attribution_relevance: boolean;
  automation_relevance: boolean;
  platforms: string[];
  reason: string;
  sort_order: number;
  properties: { name: string; type: PropertyType; required: boolean; description: string; example: unknown; allowed_values: string[] | null }[];
}

/** Loads a version's events with their properties (one query). Works under tenant or system scope. */
export async function loadPlanEvents(db: Db, versionId: string): Promise<PlanEventRow[]> {
  return db.query<PlanEventRow>(
    `select e.id, e.event_name, e.display_name, e.description, e.category, e."trigger", e.source, e.priority, e.required,
            e.activation_relevance, e.conversion_relevance, e.revenue_relevance, e.attribution_relevance, e.automation_relevance,
            e.platforms, e.reason, e.sort_order,
            coalesce((select json_agg(json_build_object('name', p.name, 'type', p.type, 'required', p.required,
                                                         'description', p.description, 'example', p.example,
                                                         'allowed_values', p.allowed_values) order by p.required desc, p.name)
                        from platform.tracking_event_properties p where p.tracking_event_id = e.id), '[]') as properties
       from platform.tracking_events e
      where e.plan_version_id = $1
      order by e.sort_order`,
    [versionId],
  );
}

export interface PublishedPlan {
  versionId: string;
  specs: Map<string, EventSpec & { source: string }>;
  mappings: Map<string, string>;
}

/** The published plan and accepted mappings for an app (system scope, used by processing). */
export async function loadPublishedPlan(db: Db, appId: string): Promise<PublishedPlan | null> {
  const plan = await db.one<{ published_version_id: string | null }>(
    "select published_version_id from platform.tracking_plans where app_id = $1",
    [appId],
  );
  const mappings = new Map(
    (await db.query<{ from_name: string; to_name: string }>(
      "select from_name, to_name from platform.event_mappings where app_id = $1 and status = 'accepted'",
      [appId],
    )).map((m) => [m.from_name, m.to_name]),
  );
  if (!plan?.published_version_id) return mappings.size ? { versionId: "", specs: new Map(), mappings } : null;
  const events = await loadPlanEvents(db, plan.published_version_id);
  return {
    versionId: plan.published_version_id,
    mappings,
    specs: new Map(
      events.map((e) => [
        e.event_name,
        {
          event_name: e.event_name,
          source: e.source,
          revenue_relevance: e.revenue_relevance,
          conversion_relevance: e.conversion_relevance,
          properties: e.properties.map((p) => ({ name: p.name, type: p.type, required: p.required, allowed_values: p.allowed_values })),
        },
      ]),
    ),
  };
}
