import "server-only";
import type { Db } from "@/lib/db";

export type AuditAction =
  | "auth.signup"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "organization.created"
  | "organization.updated"
  | "member.invited"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "invitation.revoked"
  | "app.created"
  | "app.updated"
  | "environment.created"
  | "sdk_key.created"
  | "sdk_key.rotated"
  | "sdk_key.revoked"
  | "api_key.created"
  | "api_key.revoked"
  | "implementation.answers_saved"
  | "tracking_plan.generated"
  | "tracking_plan.edited"
  | "tracking_plan.approved"
  | "tracking_plan.published"
  | "event_mapping.accepted"
  | "event_mapping.rejected";

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
