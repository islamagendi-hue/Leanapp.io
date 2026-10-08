import { SideNav } from "@/components/AppNav";
import { listApps } from "@/modules/apps/service";
import { settingsMenu, type NavGroup } from "@/modules/navigation/menu";
import { requireTenant } from "@/server/session";

/** Workspace settings. Project settings and Dev Ops live in each project's Settings. */
export default async function SettingsLayout(props: LayoutProps<"/o/[org]/settings">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const projects = await listApps(ctx);
  const menu: NavGroup[] = settingsMenu(ctx.role, org);
  if (projects.length) {
    // Before Security: Workspace, then projects (Project + Dev Ops settings), then Security.
    menu.splice(1, 0, { label: "Project settings", items: projects.map((p) => ({ label: p.name, href: `/o/${org}/apps/${p.slug}/settings` })) });
  }
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <SideNav title="Settings" back={{ href: `/o/${org}`, label: "All projects" }} menu={menu} />
      </aside>
      <main className="min-w-0 space-y-6">{props.children}</main>
    </div>
  );
}
