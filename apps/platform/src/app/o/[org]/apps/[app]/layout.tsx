import { AppNav } from "@/components/AppNav";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export default async function AppLayout(props: LayoutProps<"/o/[org]/apps/[app]">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <AppNav base={`/o/${org}/apps/${app}`} appName={a.name} privacy={can(ctx.role, "privacy.manage")} attribution={can(ctx.role, "attribution.read")} users={can(ctx.role, "users.read")}
          engage={{
            audiences: can(ctx.role, "audiences.read"),
            automations: can(ctx.role, "automations.read"),
            integrations: can(ctx.role, "integrations.read"),
            webhooks: can(ctx.role, "webhooks.manage"),
          }}
        />
      </aside>
      <main className="min-w-0">{props.children}</main>
    </div>
  );
}
