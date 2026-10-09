import { SideNav } from "@/components/AppNav";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
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
    // After You and Workspace, before Security: projects (Project + Dev Ops settings).
    menu.splice(menu.findIndex((g) => g.label === "Workspace") + 1, 0, { label: msg("Project settings"), items: projects.map((p) => ({ label: p.name, href: `/o/${org}/apps/${p.slug}/settings` })) });
  }
  const t = await getT();
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-5 lg:grid-cols-[220px_1fr] lg:py-6">
      <aside className="max-lg:contents lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pb-4">
        <SideNav title={t("Settings")} back={{ href: `/o/${org}`, label: t("All projects") }} menu={menu} />
      </aside>
      <main className="min-w-0 space-y-6">{props.children}</main>
    </div>
  );
}
