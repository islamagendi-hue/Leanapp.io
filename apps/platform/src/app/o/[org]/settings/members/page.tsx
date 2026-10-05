import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { listInvitations, listMembers } from "@/modules/organizations/service";
import { can, canAssignRole, canManageMember } from "@/modules/rbac/authorize";
import { ROLE_INFO, ROLES } from "@/modules/rbac/permissions";
import { requirePermission, requireTenant } from "@/server/session";

export const metadata = { title: "Members" };

export default async function MembersPage(props: PageProps<"/o/[org]/settings/members">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "members.read");
  const members = await listMembers(ctx);
  const invitations = can(ctx.role, "members.invite") ? await listInvitations(ctx) : [];
  const assignable = ROLES.filter((r) => canAssignRole(ctx.role, r));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <div>
        <h1 className="h1">Members</h1>
        <p className="mt-1 text-ink-2">Who can access {ctx.organizationName}, and what they can do.</p>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th /></tr></thead>
          <tbody>
            {members.map((m) => {
              const self = m.user_id === ctx.userId;
              const manageable = !self && canManageMember(ctx.role, m.role);
              return (
                <tr key={m.user_id}>
                  <td className="font-medium">{m.name}{self && <span className="ms-1 text-xs text-ink-3">(you)</span>}</td>
                  <td className="text-ink-2">{m.email}</td>
                  <td>
                    {manageable && can(ctx.role, "members.update_role") ? (
                      <ActionForm action={changeRoleAction.bind(null, org, m.user_id)} submitLabel="Save" buttonClass="btn-secondary" className="flex items-center gap-2">
                        <select name="role" defaultValue={m.role} className="input py-1" aria-label={`Role for ${m.email}`}>
                          {assignable.map((r) => <option key={r} value={r}>{ROLE_INFO[r].name}</option>)}
                        </select>
                      </ActionForm>
                    ) : (
                      ROLE_INFO[m.role].name
                    )}
                  </td>
                  <td className="text-xs text-ink-3">{new Date(m.created_at).toLocaleDateString("en-GB")}</td>
                  <td>
                    {manageable && can(ctx.role, "members.remove") && (
                      <ActionForm action={removeMemberAction.bind(null, org, m.user_id)} submitLabel="Remove" buttonClass="btn-danger" className="contents" confirm={`Remove ${m.email} from ${ctx.organizationName}?`} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {can(ctx.role, "members.invite") && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            <h2 className="h2">Invite someone</h2>
            <p className="mb-4 text-sm text-ink-3">We email the invitation link, and you&apos;ll also see it here to share yourself. Invitations expire after 7 days.</p>
            <ActionForm action={inviteMemberAction.bind(null, org)} submitLabel="Create invitation">
              <label className="block"><span className="label">Email</span><input name="email" type="email" className="input" required /></label>
              <label className="block">
                <span className="label">Role</span>
                <select name="role" className="input" defaultValue="developer">
                  {assignable.map((r) => <option key={r} value={r}>{ROLE_INFO[r].name}: {ROLE_INFO[r].description}</option>)}
                </select>
              </label>
            </ActionForm>
          </div>
          <div className="card">
            <h2 className="h2">Pending invitations</h2>
            {invitations.length === 0 ? <p className="mt-2 text-sm text-ink-3">None.</p> : (
              <ul className="mt-3 space-y-2 text-sm">
                {invitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <span>{i.email}</span>
                    <span className="pill border-line">{ROLE_INFO[i.role].name}</span>
                    <span className="text-xs text-ink-3">expires {new Date(i.expires_at).toLocaleDateString("en-GB")}</span>
                    <ActionForm action={revokeInvitationAction.bind(null, org, i.id)} submitLabel="Revoke" buttonClass="btn-secondary ms-auto" className="contents" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="h2">Roles</h2>
        <ul className="mt-2 grid gap-2 text-sm md:grid-cols-2">
          {ROLES.map((r) => <li key={r}><span className="font-medium">{ROLE_INFO[r].name}.</span> <span className="text-ink-2">{ROLE_INFO[r].description}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
