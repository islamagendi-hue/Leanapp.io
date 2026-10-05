import "server-only";
import { z } from "zod";
import { randomToken, sha256 } from "@/lib/crypto";
import { isUniqueViolation, withSystem } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { slugify } from "@/lib/slug";
import { audit } from "@/modules/audit/service";
import { sendEmail, type SendResult } from "@/modules/email/service";
import { invitationMessage } from "@/modules/email/templates";
import { assertCan, canAssignRole, canManageMember } from "@/modules/rbac/authorize";
import { isRole, ROLE_INFO, type Role } from "@/modules/rbac/permissions";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { publicAppUrl } from "@/server/env";

export const INDUSTRIES = [
  "ecommerce", "marketplace", "delivery", "subscription", "fintech", "edtech", "healthcare",
  "gaming", "social", "saas", "booking", "lead_generation", "advertising", "other",
] as const;

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, "Enter the organization name.").max(120),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Choose a country.").optional().or(z.literal("")),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  defaultCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code.").default("USD"),
  industry: z.enum(INDUSTRIES).optional().or(z.literal("")),
});

export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Creates an organization and makes the creator its owner. System scope: the tenant does not exist yet. */
export async function createOrganization(userId: string, input: unknown): Promise<OrganizationSummary> {
  const r = createOrganizationSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  const data = r.data;
  if (!validTimezone(data.timezone)) throw new ValidationError("Unknown timezone.");
  const base = slugify(data.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, 40)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    try {
      return await withSystem(async (db) => {
        const org = await db.one<{ id: string }>(
          `insert into platform.organizations (name, slug, country, timezone, default_currency, industry)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [data.name, slug, data.country || null, data.timezone, data.defaultCurrency, data.industry || null],
        );
        await db.query(
          "insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, 'owner')",
          [org!.id, userId],
        );
        await audit(db, { organizationId: org!.id, actorUserId: userId, action: "organization.created", targetType: "organization", targetId: org!.id });
        return { id: org!.id, slug, name: data.name, role: "owner" as const };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ConflictError("Could not allocate a unique organization URL. Try a different name.");
}

export async function listOrganizationsForUser(userId: string): Promise<OrganizationSummary[]> {
  return withSystem((db) =>
    db.query<OrganizationSummary>(
      `select o.id, o.slug, o.name, m.role_id as role
         from platform.organization_members m join platform.organizations o on o.id = m.organization_id
        where m.user_id = $1 and o.status = 'active' order by o.name`,
      [userId],
    ),
  );
}

export interface OrganizationDetails {
  id: string;
  name: string;
  slug: string;
  country: string | null;
  timezone: string;
  default_currency: string;
  industry: string | null;
  plan_id: string;
}

export function getOrganization(ctx: TenantContext): Promise<OrganizationDetails> {
  return tenantTx(ctx, "organization.read", async (db) => {
    const row = await db.one<OrganizationDetails>(
      "select id, name, slug, country, timezone, default_currency, industry, plan_id from platform.organizations where id = $1",
      [ctx.organizationId],
    );
    if (!row) throw new NotFoundError("Organization");
    return row;
  });
}

/** Edits the organization profile. The slug (its URL) doesn't change. */
export async function updateOrganization(ctx: TenantContext, input: unknown): Promise<void> {
  const r = createOrganizationSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  const data = r.data;
  if (!validTimezone(data.timezone)) throw new ValidationError("Unknown timezone.");
  await tenantTx(ctx, "organization.update", async (db) => {
    const before = await db.one<Record<string, string | null>>(
      "select name, country, timezone, default_currency, industry from platform.organizations where id = $1",
      [ctx.organizationId],
    );
    if (!before) throw new NotFoundError("Organization");
    const after: Record<string, string | null> = {
      name: data.name, country: data.country || null, timezone: data.timezone, default_currency: data.defaultCurrency, industry: data.industry || null,
    };
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    if (!changed.length) return;
    await db.query(
      "update platform.organizations set name = $2, country = $3, timezone = $4, default_currency = $5, industry = $6 where id = $1",
      [ctx.organizationId, after.name, after.country, after.timezone, after.default_currency, after.industry],
    );
    await audit(db, {
      organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "organization.updated", targetType: "organization", targetId: ctx.organizationId,
      metadata: { changed: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])) },
    });
  });
}

// ── Members ─────────────────────────────────────────────────────────────────
export interface Member {
  user_id: string;
  name: string;
  email: string;
  role: Role;
  created_at: Date;
}

export function listMembers(ctx: TenantContext): Promise<Member[]> {
  return tenantTx(ctx, "members.read", (db) =>
    db.query<Member>(
      `select m.user_id, u.name, u.email, m.role_id as role, m.created_at
         from platform.organization_members m join platform.users u on u.id = m.user_id
        order by m.created_at`,
    ),
  );
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expires_at: Date;
}

export function listInvitations(ctx: TenantContext): Promise<PendingInvitation[]> {
  return tenantTx(ctx, "members.read", (db) =>
    db.query<PendingInvitation>(
      `select id, email, role_id as role, expires_at from platform.organization_invitations
        where accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc`,
    ),
  );
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  role: z.string().refine(isRole, "Choose a role."),
});

/**
 * Creates an invitation, emails the one-time link and returns the token so the
 * inviter can share the link themselves when delivery fails or no provider is
 * configured. The token is stored only as a hash.
 */
export async function inviteMember(ctx: TenantContext, input: unknown): Promise<{ token: string; invitationId: string; link: string; delivery: SendResult }> {
  const r = inviteSchema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? "Invalid input.");
  const role = r.data.role as Role;
  assertCan(ctx.role, "members.invite");
  if (!canAssignRole(ctx.role, role)) throw new ForbiddenError("You can't invite someone with a higher role than yours.");
  const token = randomToken(24);
  const { id, inviter } = await tenantTx(ctx, "members.invite", async (db) => {
    const existing = await db.one(
      `select 1 from platform.organization_members m join platform.users u on u.id = m.user_id where lower(u.email) = $1`,
      [r.data.email],
    );
    if (existing) throw new ConflictError("That person is already a member.");
    const row = await db.one<{ id: string }>(
      `insert into platform.organization_invitations (organization_id, email, role_id, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '7 days') returning id`,
      [ctx.organizationId, r.data.email, role, sha256(token), ctx.userId],
    );
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "member.invited", targetType: "invitation", targetId: row!.id, metadata: { email: r.data.email, role } });
    const me = await db.one<{ name: string }>("select name from platform.users where id = $1", [ctx.userId]);
    return { id: row!.id, inviter: me?.name ?? "A teammate" };
  });
  const link = `${publicAppUrl()}/invite/${token}`;
  const delivery = await sendEmail(invitationMessage(r.data.email, inviter, ctx.organizationName, ROLE_INFO[role].name, link));
  return { token, invitationId: id, link, delivery };
}

export async function revokeInvitation(ctx: TenantContext, invitationId: string): Promise<void> {
  await tenantTx(ctx, "members.invite", async (db) => {
    const row = await db.one("update platform.organization_invitations set revoked_at = now() where id = $1 and accepted_at is null returning id", [invitationId]);
    if (!row) throw new NotFoundError("Invitation");
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "invitation.revoked", targetType: "invitation", targetId: invitationId });
  });
}

/** Accepts an invitation for the signed-in user. The invitation email must match the account email. */
export async function acceptInvitation(user: { id: string; email: string }, token: string): Promise<OrganizationSummary> {
  return withSystem(async (db) => {
    const inv = await db.one<{ id: string; organization_id: string; email: string; role_id: Role; slug: string; name: string }>(
      `select i.id, i.organization_id, i.email, i.role_id, o.slug, o.name
         from platform.organization_invitations i join platform.organizations o on o.id = i.organization_id
        where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
        for update of i`,
      [sha256(token)],
    );
    if (!inv) throw new NotFoundError("Invitation");
    if (inv.email.toLowerCase() !== user.email.toLowerCase())
      throw new ForbiddenError(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    await db.query(
      `insert into platform.organization_members (organization_id, user_id, role_id) values ($1, $2, $3)
       on conflict (organization_id, user_id) do nothing`,
      [inv.organization_id, user.id, inv.role_id],
    );
    await db.query("update platform.organization_invitations set accepted_at = now() where id = $1", [inv.id]);
    await audit(db, { organizationId: inv.organization_id, actorUserId: user.id, action: "member.joined", targetType: "user", targetId: user.id, metadata: { role: inv.role_id } });
    return { id: inv.organization_id, slug: inv.slug, name: inv.name, role: inv.role_id };
  });
}

export async function changeMemberRole(ctx: TenantContext, memberUserId: string, newRole: unknown): Promise<void> {
  if (!isRole(newRole)) throw new ValidationError("Choose a role.");
  await tenantTx(ctx, "members.update_role", async (db) => {
    const member = await db.one<{ role_id: Role }>(
      "select role_id from platform.organization_members where user_id = $1 for update",
      [memberUserId],
    );
    if (!member) throw new NotFoundError("Member");
    if (!canManageMember(ctx.role, member.role_id) || !canAssignRole(ctx.role, newRole))
      throw new ForbiddenError("You can't change this member's role.");
    if (member.role_id === "owner" && newRole !== "owner") await assertAnotherOwner(db, memberUserId);
    await db.query("update platform.organization_members set role_id = $2 where user_id = $1", [memberUserId, newRole]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "member.role_changed", targetType: "user", targetId: memberUserId, metadata: { from: member.role_id, to: newRole } });
  });
}

export async function removeMember(ctx: TenantContext, memberUserId: string): Promise<void> {
  await tenantTx(ctx, "members.remove", async (db) => {
    const member = await db.one<{ role_id: Role }>("select role_id from platform.organization_members where user_id = $1 for update", [memberUserId]);
    if (!member) throw new NotFoundError("Member");
    if (!canManageMember(ctx.role, member.role_id)) throw new ForbiddenError("You can't remove this member.");
    if (member.role_id === "owner") await assertAnotherOwner(db, memberUserId);
    await db.query("delete from platform.organization_members where user_id = $1", [memberUserId]);
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "member.removed", targetType: "user", targetId: memberUserId });
  });
}

async function assertAnotherOwner(db: { one: (q: string, v?: unknown[]) => Promise<unknown> }, exceptUserId: string) {
  const other = await db.one("select 1 from platform.organization_members where role_id = 'owner' and user_id <> $1 limit 1", [exceptUserId]);
  if (!other) throw new ConflictError("An organization needs at least one owner.");
}
