import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { ROLE_INFO } from "@/modules/rbac/permissions";
import { currentUser, requireTenant } from "@/server/session";

export default async function OrgLayout(props: LayoutProps<"/o/[org]">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const user = await currentUser();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href={`/o/${org}`} className="font-bold">{ctx.organizationName}</Link>
          <nav className="flex flex-wrap gap-4 text-sm text-ink-2">
            <Link href={`/o/${org}`} className="hover:text-ink">Apps</Link>
            <Link href={`/o/${org}/settings/members`} className="hover:text-ink">Members</Link>
            <Link href="/onboarding" className="hover:text-ink">Switch organization</Link>
          </nav>
          <div className="ms-auto flex items-center gap-3 text-sm text-ink-3">
            <span className="hidden sm:inline">{user?.email}</span>
            <span className="pill border-line">{ROLE_INFO[ctx.role].name}</span>
            <form action={signOutAction}>
              <button className="underline hover:text-ink" type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      {props.children}
    </div>
  );
}
