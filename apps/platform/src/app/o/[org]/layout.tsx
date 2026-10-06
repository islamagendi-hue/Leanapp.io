import Link from "next/link";
import { signOutAction } from "@/app/actions/auth";
import { LogoMark } from "@/components/Logo";
import { PlanBanner } from "@/components/PlanBanner";
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
          <Link href={`/o/${org}`} className="flex items-center gap-2 font-bold">
            <LogoMark size={24} />
            {ctx.organizationName}
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm text-ink-2">
            <Link href={`/o/${org}`} className="hover:text-ink">Apps</Link>
            <Link href={`/o/${org}/settings/members`} className="hover:text-ink">Members</Link>
            <Link href={`/o/${org}/settings`} className="hover:text-ink">Settings</Link>
            <Link href="/onboarding" className="hover:text-ink">Switch organization</Link>
          </nav>
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
