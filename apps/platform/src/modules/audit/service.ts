import "server-only";
import type { Db } from "@/lib/db";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";

export type AuditAction =
  | "auth.signup"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.email_verified"
  | "auth.password_reset_requested"
  | "auth.password_reset"
  | "auth.password_changed"
  | "auth.sessions_revoked"
  | "auth.profile_updated"
  | "organization.created"
  | "organization.updated"
  | "member.invited"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "invitation.revoked"
  | "app.created"
  | "app.updated"
  | "app.locale_updated"
  | "app.archived"
  | "app.restored"
  | "environment.created"
  | "environment.enabled"
  | "environment.disabled"
  | "sdk_key.created"
  | "sdk_key.rotated"
  | "sdk_key.revoked"
  | "api_key.created"
  | "api_key.revoked"
  | "implementation.answers_saved"
  | "tracking_plan.generated"
  | "tracking_plan.draft_created"
  | "tracking_plan.edited"
  | "tracking_plan.approved"
  | "tracking_plan.published"
  | "event_mapping.accepted"
  | "event_mapping.rejected"
  | "event_mapping.reverted"
  | "events.retried"
  | "property.described"
  | "dashboard.created"
  | "dashboard.updated"
  | "message.test_sent"
  | "dashboard.deleted"
  | "app.feature_changed"
  | "privacy.export"
  | "privacy.deletion_requested"
  | "privacy.deletion_completed"
  | "audience.created"
  | "audience.updated"
  | "audience.activated"
  | "audience.archived"
  | "automation.created"
  | "automation.updated"
  | "automation.activated"
  | "automation.paused"
  | "automation.archived"
  | "experiment.created"
  | "experiment.updated"
  | "experiment.started"
  | "experiment.stopped"
  | "webhook.created"
  | "webhook.updated"
  | "webhook.secret_rotated"
  | "webhook.deleted"
  | "integration.configured"
  | "integration.removed"
  | "email_template.created"
  | "email_template.updated"
  | "email_template.deleted"
  | "email_domain.added"
  | "email_domain.verified"
  | "email_domain.removed"
  | "billing.checkout_started"
  | "billing.checkout_completed"
  | "billing.portal_opened"
  | "billing.subscription_updated"
  | "billing.plan_changed"
  | "billing.invoice_paid"
  | "billing.payment_failed"
  | "billing.refund_recorded"
  | "billing.subscription_reconciled"
  | "attribution.settings_updated"
  | "attribution.link_created"
  | "attribution.link_updated"
  | "attribution.postback_created"
  | "attribution.postback_updated"
  | "attribution.postback_deleted"
  | "deep_links.config_updated"
  | "attribution.skan_settings_updated"
  | "attribution.skan_schema_updated"
  | "attribution.spend_saved"
  | "attribution.spend_imported"
  | "attribution.spend_deleted"
  | "channels.channel_created"
  | "channels.channel_updated"
  | "channels.rule_created"
  | "channels.rule_updated"
  | "channels.rule_deleted"
  | "cohort.created"
  | "cohort.updated"
  | "cohort.deleted"
  | "saved_report.created"
  | "saved_report.deleted"
  | "privacy.suppression_added"
  | "privacy.suppression_removed";

export interface AuditEntry {
  organizationId: string | null;
  actorUserId: string | null;
  actorType?: "user" | "system" | "api_key" | "platform_admin";
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Appends to the audit log inside the caller's transaction (so it commits or rolls back with the change). */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into platform.audit_logs (organization_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.organizationId,
      e.actorUserId,
      e.actorType ?? "user",
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}

export interface AuditLogRow {
  id: string;
  action: string;
  actor_type: AuditEntry["actorType"];
  actor_name: string | null;
  actor_email: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** The organization's audit log, newest first. `before` is the last id of the previous page; `area` filters by action prefix (e.g. "member"). */
export async function listAuditLogs(ctx: TenantContext, opts: { before?: string; area?: string; limit?: number } = {}): Promise<{ rows: AuditLogRow[]; next: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const before = opts.before && /^\d{1,18}$/.test(opts.before) ? opts.before : null;
  const area = opts.area && /^[a-z_]{1,40}$/.test(opts.area) ? opts.area : null;
  const rows = await tenantTx(ctx, "audit.read", (db) =>
    db.query<AuditLogRow>(
      `select l.id::text, l.action, l.actor_type, u.name as actor_name, u.email as actor_email, l.target_type, l.target_id, l.metadata, l.created_at
         from platform.audit_logs l
         left join platform.users u on u.id = l.actor_user_id
        where l.organization_id = $1
          and ($2::bigint is null or l.id < $2)
          and ($3::text is null or l.action like $3 || '.%')
        order by l.id desc limit $4`,
      [ctx.organizationId, before, area, limit + 1],
    ),
  );
  const more = rows.length > limit;
  if (more) rows.length = limit;
  return { rows, next: more ? rows[rows.length - 1].id : null };
}
