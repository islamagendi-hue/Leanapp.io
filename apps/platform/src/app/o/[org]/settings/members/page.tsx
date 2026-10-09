import { changeRoleAction, inviteMemberAction, removeMemberAction, revokeInvitationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { getLang, getT } from "@/i18n/server";
import { dateLocale } from "@/i18n/translate";
import { listInvitations, listMembers } from "@/modules/organizations/service";
import { can, canAssignRole, canManageMember } from "@/modules/rbac/authorize";
import { ROLE_INFO, ROLES } from "@/modules/rbac/permissions";
import { requirePermission, requireTenant } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Members") };
}

export default async function MembersPage(props: PageProps<"/o/[org]/settings/members">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "members.read");
  const members = await listMembers(ctx);
  const invitations = can(ctx.role, "members.invite") ? await listInvitations(ctx) : [];
  const assignable = ROLES.filter((r) => canAssignRole(ctx.role, r));
  const t = await getT();
  const lang = await getLang();
  const date = (d: Date) => new Date(d).toLocaleDateString(dateLocale(lang));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Members")}</h1>
        <p className="mt-1 text-ink-2">{t("Who can access {org}, and what they can do.", { org: ctx.organizationName })}</p>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="table">
          <thead><tr><th>{t("Name")}</th><th>{t("Email")}</th><th>{t("Role")}</th><th>{t("Joined")}</th><th /></tr></thead>
          <tbody>
            {members.map((m) => {
              const self = m.user_id === ctx.userId;
              const manageable = !self && canManageMember(ctx.role, m.role);
              return (
                <tr key={m.user_id}>
                  <td className="font-medium">{m.name}{self && <span className="ms-1 text-xs text-ink-3">{t("(you)")}</span>}</td>
                  <td className="text-ink-2" dir="ltr">{m.email}</td>
                  <td>
                    {manageable && can(ctx.role, "members.update_role") ? (
                      <ActionForm action={changeRoleAction.bind(null, org, m.user_id)} submitLabel={t("Save")} buttonClass="btn-secondary" className="flex items-center gap-2">
                        <select name="role" defaultValue={m.role} className="input py-1" aria-label={t("Role for {email}", { email: m.email })}>
                          {assignable.map((r) => <option key={r} value={r}>{t(ROLE_INFO[r].name)}</option>)}
                        </select>
                      </ActionForm>
                    ) : (
                      t(ROLE_INFO[m.role].name)
                    )}
                  </td>
                  <td className="text-xs text-ink-3">{date(m.created_at)}</td>
                  <td>
                    {manageable && can(ctx.role, "members.remove") && (
                      <ActionForm action={removeMemberAction.bind(null, org, m.user_id)} submitLabel={t("Remove")} buttonClass="btn-danger" className="contents" confirm={t("Remove {email} from {org}?", { email: m.email, org: ctx.organizationName })} />
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
            <h2 className="h2">{t("Invite someone")}</h2>
            <p className="mb-4 text-sm text-ink-3">{t("We email the invitation link, and you'll also see it here to share yourself. Invitations expire after 7 days.")}</p>
            <ActionForm action={inviteMemberAction.bind(null, org)} submitLabel={t("Create invitation")}>
              <label className="block"><span className="label">{t("Email")}</span><input name="email" type="email" className="input" dir="ltr" required /></label>
              <label className="block">
                <span className="label">{t("Role")}</span>
                <select name="role" className="input" defaultValue="developer">
                  {assignable.map((r) => <option key={r} value={r}>{t(ROLE_INFO[r].name)}: {t(ROLE_INFO[r].description)}</option>)}
                </select>
              </label>
            </ActionForm>
          </div>
          <div className="card">
            <h2 className="h2">{t("Pending invitations")}</h2>
            {invitations.length === 0 ? <p className="mt-2 text-sm text-ink-3">{t("None.")}</p> : (
              <ul className="mt-3 space-y-2 text-sm">
                {invitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <span dir="ltr">{i.email}</span>
                    <span className="pill border-line">{t(ROLE_INFO[i.role].name)}</span>
                    <span className="text-xs text-ink-3">{t("expires {date}", { date: date(i.expires_at) })}</span>
                    <ActionForm action={revokeInvitationAction.bind(null, org, i.id)} submitLabel={t("Revoke")} buttonClass="btn-secondary ms-auto" className="contents" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h2 className="h2">{t("Roles")}</h2>
        <ul className="mt-2 grid gap-2 text-sm md:grid-cols-2">
          {ROLES.map((r) => <li key={r}><span className="font-medium">{t(ROLE_INFO[r].name)}.</span> <span className="text-ink-2">{t(ROLE_INFO[r].description)}</span></li>)}
        </ul>
      </div>
    </div>
  );
}
