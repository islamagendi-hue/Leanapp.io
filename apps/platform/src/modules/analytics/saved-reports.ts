import "server-only";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { inputFromParams, REPORT_KINDS, type ReportKind } from "./report-params";
import { revenueSchema } from "./revenue";
import { analyticsTx, funnelSchema, retentionSchema, trendSchema } from "./service";

/**
 * Saved reports: a named, validated report configuration (trend, funnel,
 * retention or revenue) per app environment. Opening one runs the report
 * again on current data; results are never stored.
 */

const SCHEMAS: Record<ReportKind, z.ZodType> = {
  trend: trendSchema,
  funnel: funnelSchema,
  retention: retentionSchema,
  revenue: revenueSchema,
};

export interface SavedReport {
  id: string;
  name: string;
  kind: ReportKind;
  config: Record<string, unknown>;
  created_at: Date;
  created_by_name: string | null;
}

/** Validates a report configuration for its kind; unknown keys are dropped. */
export function reportConfig(kind: unknown, input: unknown): { kind: ReportKind; config: Record<string, unknown> } {
  const k = z.enum(REPORT_KINDS).safeParse(kind);
  if (!k.success) throw new ValidationError("Unknown report type.");
  const r = SCHEMAS[k.data].safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "This report isn't complete yet.");
  const config = Object.fromEntries(Object.entries(r.data as Record<string, unknown>).filter(([, v]) => v !== undefined));
  return { kind: k.data, config };
}

export async function listSavedReports(ctx: TenantContext, environmentId: string): Promise<SavedReport[]> {
  return analyticsTx(ctx, (db) =>
    db.query<SavedReport>(
      `select r.id, r.name, r.kind, r.config, r.created_at, (select u.name from platform.users u where u.id = r.created_by) as created_by_name
         from platform.analytics_saved_reports r where r.environment_id = $1 order by lower(r.name)`,
      [environmentId],
    ),
  );
}

/** Saves the report shown by a page: `query` is the page's search params. */
export async function saveReport(
  ctx: TenantContext,
  environmentId: string,
  input: { name: unknown; kind: unknown; query: URLSearchParams },
): Promise<{ id: string }> {
  const name = z.string().trim().min(1, "Name the report.").max(100, "Use at most 100 characters.").safeParse(input.name);
  if (!name.success) throw new ValidationError(name.error.issues[0].message, { name: name.error.issues[0].message });
  const kind = z.enum(REPORT_KINDS).safeParse(input.kind);
  if (!kind.success) throw new ValidationError("Unknown report type.");
  const { config } = reportConfig(kind.data, inputFromParams(kind.data, input.query));
  return analyticsTx(
    ctx,
    async (db) => {
      const env = await db.one<{ app_id: string }>("select app_id from platform.environments where id = $1", [environmentId]);
      if (!env) throw new NotFoundError("Environment");
      const row = await db
        .one<{ id: string }>(
          `insert into platform.analytics_saved_reports (organization_id, app_id, environment_id, name, kind, config, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [ctx.organizationId, env.app_id, environmentId, name.data, kind.data, JSON.stringify(config), ctx.userId],
        )
        .catch((e: { code?: string }) => {
          if (e?.code === "23505") throw new ConflictError("A report with this name already exists in this environment.");
          throw e;
        });
      await audit(db, {
        organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "saved_report.created",
        targetType: "saved_report", targetId: row!.id, metadata: { name: name.data, kind: kind.data, environmentId },
      });
      return { id: row!.id };
    },
    "analytics.write",
  );
}

export async function deleteSavedReport(ctx: TenantContext, environmentId: string, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Report");
  await analyticsTx(
    ctx,
    async (db) => {
      const row = await db.one<{ name: string }>(
        "delete from platform.analytics_saved_reports where id = $1 and environment_id = $2 returning name",
        [id, environmentId],
      );
      if (!row) throw new NotFoundError("Report");
      await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "saved_report.deleted", targetType: "saved_report", targetId: id, metadata: { name: row.name } });
    },
    "analytics.write",
  );
}
