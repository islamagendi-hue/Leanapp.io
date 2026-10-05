import { updateOrganizationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { OrganizationFields } from "@/components/OrganizationFields";
import { can } from "@/modules/rbac/authorize";
import { getOrganization } from "@/modules/organizations/service";
import { requireTenant } from "@/server/session";

export const metadata = { title: "Organization settings" };

export default async function OrganizationSettingsPage(props: PageProps<"/o/[org]/settings">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  const o = await getOrganization(ctx);
  const values = { name: o.name, country: o.country ?? "", industry: o.industry ?? "", timezone: o.timezone, currency: o.default_currency };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Organization</h1>
        <p className="mt-1 text-ink-2">
          URL: <span className="font-mono text-sm">/o/{o.slug}</span>. The default currency and timezone apply to new apps; existing apps keep their own.
        </p>
      </div>
      <section className="card max-w-2xl">
        {can(ctx.role, "organization.update") ? (
          <ActionForm action={updateOrganizationAction.bind(null, org)} submitLabel="Save changes" pendingLabel="Saving…">
            <OrganizationFields values={values} />
          </ActionForm>
        ) : (
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-ink-3">Name</dt><dd>{o.name}</dd>
            <dt className="text-ink-3">Country</dt><dd>{o.country ?? "–"}</dd>
            <dt className="text-ink-3">Industry</dt><dd>{o.industry?.replace(/_/g, " ") ?? "–"}</dd>
            <dt className="text-ink-3">Timezone</dt><dd>{o.timezone}</dd>
            <dt className="text-ink-3">Currency</dt><dd>{o.default_currency}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
