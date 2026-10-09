import "server-only";
import type { Db } from "@/lib/db";
import { assertCan } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

/** Who a template sync runs as: a dashboard user (checked for integrations.manage), or the scheduled worker (no user). */
export type SyncScope = { organizationId: string; userId: string | null; system: true };

export function syncScope(ctx: TenantContext | SyncScope): { organizationId: string; userId: string | null } {
  if ("system" in ctx) return { organizationId: ctx.organizationId, userId: null };
  assertCan(ctx.role, "integrations.manage");
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** One synced provider template, as stored in platform.whatsapp_templates. */
export interface TemplateRowInput {
  external_id: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejected_reason: string | null;
  components: unknown[];
  body_params: number;
  header_params: number;
  header_format: string | null;
  variables: string[];
  parameter_format: string;
  quality_score?: string | null;
}

/** Stores a provider's synced templates: upserts what came back, removes what the provider no longer has. Other providers' rows are untouched. */
export async function upsertTemplates(
  db: Db, organizationId: string, appId: string, environmentId: string, integrationId: string, provider: "whatsapp_cloud" | "twilio", rows: TemplateRowInput[],
): Promise<void> {
  await db.query(
    `insert into platform.whatsapp_templates (organization_id, app_id, environment_id, integration_id, provider, external_id, name, language, category, status, rejected_reason,
                                              components, body_params, header_params, header_format, variables, parameter_format, quality_score, synced_at)
     select $1, $2, $3, $4, $5, r.external_id, r.name, r.language, r.category, r.status, r.rejected_reason, r.components, r.body_params, r.header_params,
            r.header_format, r.variables, r.parameter_format, r.quality_score, now()
       from jsonb_to_recordset($6::jsonb) as r(external_id text, name text, language text, category text, status text, rejected_reason text, components jsonb,
                                                body_params int, header_params int, header_format text, variables jsonb, parameter_format text, quality_score text)
     on conflict (environment_id, provider, name, language) do update
       set external_id = excluded.external_id, category = excluded.category, status = excluded.status, rejected_reason = excluded.rejected_reason,
           components = excluded.components, body_params = excluded.body_params, header_params = excluded.header_params, header_format = excluded.header_format,
           variables = excluded.variables, parameter_format = excluded.parameter_format, quality_score = excluded.quality_score,
           integration_id = excluded.integration_id, synced_at = now()`,
    [organizationId, appId, environmentId, integrationId, provider, JSON.stringify(rows.map((r) => ({ ...r, quality_score: r.quality_score ?? null })))],
  );
  await db.query(
    `delete from platform.whatsapp_templates t where t.environment_id = $1 and t.provider = $2
        and not exists (select 1 from jsonb_to_recordset($3::jsonb) as r(name text, language text) where r.name = t.name and r.language = t.language)`,
    [environmentId, provider, JSON.stringify(rows.map((r) => ({ name: r.name, language: r.language })))],
  );
}
