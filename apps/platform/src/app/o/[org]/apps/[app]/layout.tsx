import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { QuickSearch } from "@/components/QuickSearch";
import { planEventList } from "@/modules/analytics/labels";
import { can } from "@/modules/rbac/authorize";
import { projectMenu, settingsMenu } from "@/modules/navigation/menu";
import { loadApp } from "@/server/session";

export default async function AppLayout(props: LayoutProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  const menu = projectMenu(ctx.role, base);
  const settings = settingsMenu(ctx.role, org, base);
  const events = can(ctx.role, "analytics.read") ? await planEventList(ctx, a.id) : [];
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <QuickSearch base={base} menu={menu} settings={settings} events={events} canUsers={can(ctx.role, "users.read")} />
        <AppNav base={base} appName={a.name} menu={menu} settings={settings} />
      </aside>
      <main className="min-w-0">
        {a.status === "archived" && (
          <p className="mb-6 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm" role="status">
            This project is archived, so it receives no events. Its data is kept.{" "}
            <Link className="font-medium underline underline-offset-2" href={`${base}/settings/project`}>Project settings</Link>
          </p>
        )}
        {props.children}
      </main>
    </div>
  );
}
