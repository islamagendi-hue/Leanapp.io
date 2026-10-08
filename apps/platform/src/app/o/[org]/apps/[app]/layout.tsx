import { AppNav } from "@/components/AppNav";
import { projectMenu, settingsMenu } from "@/modules/navigation/menu";
import { loadApp } from "@/server/session";

export default async function AppLayout(props: LayoutProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  const base = `/o/${org}/apps/${app}`;
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <AppNav base={base} appName={a.name} menu={projectMenu(ctx.role, base)} settings={settingsMenu(ctx.role, org, base)} />
      </aside>
      <main className="min-w-0">{props.children}</main>
    </div>
  );
}
