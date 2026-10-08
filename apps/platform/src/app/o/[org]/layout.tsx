import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { signOutAction } from "@/app/actions/auth";
import { LogoMark } from "@/components/Logo";
import { PlanBanner } from "@/components/PlanBanner";
import { EnvironmentSelect, ProjectSwitcher, WorkspaceSwitcher } from "@/components/TopBar";
import { ENV_COOKIE, isEnvironmentName } from "@/lib/environment";
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
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <Link href={`/o/${org}`} className="flex items-center" aria-label="LeanApp home">
            <LogoMark size={24} />
          </Link>
          <nav aria-label="Workspace and project" className="flex flex-wrap items-center gap-1 text-sm font-medium">
            <WorkspaceSwitcher current={{ slug: ctx.organizationSlug, name: ctx.organizationName }} workspaces={workspaces.map((w) => ({ slug: w.slug, name: w.name }))} />
            <span aria-hidden className="text-ink-3">/</span>
            <ProjectSwitcher
              org={org}
              projects={projects.map((p) => ({ slug: p.slug, name: p.name }))}
              archived={archived.map((p) => ({ slug: p.slug, name: p.name }))}
              canCreate={can(ctx.role, "apps.create")}
            />
          </nav>
          <Suspense>
            <EnvironmentSelect initial={isEnvironmentName(env) ? env : undefined} />
          </Suspense>
          <div className="ms-auto flex items-center gap-3 text-sm text-ink-3">
            <Link href="/account" className="hidden hover:text-ink sm:inline">{user?.email}</Link>
            <span className="pill border-line">{ROLE_INFO[ctx.role].name}</span>
            <form action={signOutAction}>
              <button className="underline hover:text-ink" type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      {user && !user.emailVerified && (
        <div className="border-b border-line bg-warn-soft px-4 py-2 text-center text-sm text-warn">
          Please confirm your email address ({user.email}).{" "}
          <Link href="/account" className="underline">Resend the link</Link>
        </div>
      )}
      <PlanBanner ctx={ctx} />
      {props.children}
    </div>
  );
}
