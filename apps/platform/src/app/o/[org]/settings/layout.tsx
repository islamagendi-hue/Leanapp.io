import { SettingsNav } from "@/components/SettingsNav";
import { can } from "@/modules/rbac/authorize";
import { requireTenant } from "@/server/session";

export default async function SettingsLayout(props: LayoutProps<"/o/[org]/settings">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const base = `/o/${org}/settings`;
  const tabs = [
    { label: "General", href: base, show: true },
    { label: "Members", href: `${base}/members`, show: can(ctx.role, "members.read") },
    { label: "Plan & billing", href: `${base}/billing`, show: can(ctx.role, "billing.read") },
    { label: "Audit log", href: `${base}/audit`, show: can(ctx.role, "audit.read") },
  ].filter((t) => t.show);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <SettingsNav tabs={tabs} />
      {props.children}
    </div>
  );
}
