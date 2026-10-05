import { ForbiddenError } from "@/lib/errors";
import { ROLE_INFO, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "./permissions";

const grants = new Map<Role, ReadonlySet<Permission>>(ROLES.map((r) => [r, new Set(ROLE_PERMISSIONS[r])]));

export function can(role: Role, permission: Permission): boolean {
  return grants.get(role)?.has(permission) ?? false;
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError();
}

/**
 * Role assignment rules: you can only grant or change roles at or below your own
 * rank, only an owner can create or demote another owner, and an organization
 * always keeps at least one owner (enforced in the members service).
 */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (!can(actor, "members.update_role") && !can(actor, "members.invite")) return false;
  if (target === "owner") return actor === "owner";
  return ROLE_INFO[actor].rank >= ROLE_INFO[target].rank;
}

export function canManageMember(actor: Role, memberRole: Role): boolean {
  if (memberRole === "owner") return actor === "owner";
  return ROLE_INFO[actor].rank >= ROLE_INFO[memberRole].rank;
}
