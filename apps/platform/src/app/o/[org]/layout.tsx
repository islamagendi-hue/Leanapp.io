import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { signOutAction } from "@/app/actions/auth";
import { LogoMark } from "@/components/Logo";
import { PlanBanner } from "@/components/PlanBanner";
import { initials } from "@/components/account/AccountSections";
import { AccountMenu, EnvironmentBadge, NavButtons, ProjectSwitcher, WorkspaceSwitcher } from "@/components/TopBar";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { ENV_COOKIE, isEnvironmentName } from "@/lib/environment";
import { getTheme } from "@/lib/theme";
import { listApps, listArchivedApps } from "@/modules/apps/service";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { ROLE_INFO } from "@/modules/rbac/permissions";
import { currentUser, requireTenant } from "@/server/session";

export default async function OrgLayout(props: LayoutProps<"/o/[org]">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const user = await currentUser();
  const [workspaces, projects, archived] = await Promise.all([user ? listOrganizationsForUser(user.id) : [], listApps(ctx), listArchivedApps(ctx)]);
  const env = (await cookies()).get(ENV_COOKIE)?.value;
  const ws = `/o/${org}/settings`;
  const t = await getT();
  const accountLinks = [
    { label: msg("Your profile"), href: `${ws}/profile`, show: true },
    { label: msg("Organization settings"), href: ws, show: can(ctx.role, "organization.read") },
    { label: msg("Members & invitations"), href: `${ws}/members`, show: can(ctx.role, "members.read") },
    { label: msg("API keys"), href: `${ws}/api-keys`, show: can(ctx.role, "credentials.read") },
    { label: msg("Billing & plan"), href: `${ws}/billing`, show: can(ctx.role, "billing.read") },
    { label: msg("Help & support"), href: `${ws}/support`, show: true },
  ].filter((l) => l.show).map(({ label, href }) => ({ label, href }));
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 sm:gap-x-3 lg:py-3">
          <Link href={`/o/${org}`} className="flex items-center" aria-label="LeanApp home">
            <LogoMark size={24} />
          </Link>
          <nav aria-label={t("Workspace and project")} className="flex min-w-0 items-center gap-0.5 text-sm font-medium sm:gap-1">
            <WorkspaceSwitcher current={{ slug: ctx.organizationSlug, name: ctx.organizationName }} workspaces={workspaces.map((w) => ({ slug: w.slug, name: w.name }))} />
            <ProjectSwitcher
              org={org}
              projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}
              archived={archived.map((p) => ({ slug: p.slug, name: p.name }))}
              canCreate={can(ctx.role, "apps.create")}
            />
          </nav>
          <Suspense>
            <EnvironmentBadge org={org} initial={isEnvironmentName(env) ? env : undefined} />
          </Suspense>
          <div className="ms-auto flex items-center gap-1 text-sm">
            <NavButtons />
            <AccountMenu
              name={user?.name ?? ""}
              email={user?.email ?? ""}
              initials={initials(user?.name, user?.email ?? "?")}
              role={ROLE_INFO[ctx.role].name}
              links={accountLinks}
              signOut={signOutAction}
              theme={await getTheme()}
            />
          </div>
        </div>
      </header>
      {user && !user.emailVerified && (
        <div className="border-b border-line bg-warn-soft px-4 py-2 text-center text-sm text-warn">
          {t("Please confirm your email address ({email}).", { email: user.email })}{" "}
          <Link href={`/o/${org}/settings/profile`} className="underline">{t("Resend the link")}</Link>
        </div>
      )}
      <PlanBanner ctx={ctx} />
      {props.children}
    </div>
  );
}
