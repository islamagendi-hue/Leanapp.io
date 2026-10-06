import Link from "next/link";
import { createOrganizationAction } from "@/app/actions/organizations";
import { ActionForm } from "@/components/ActionForm";
import { AuthShell } from "@/components/AuthShell";
import { OrganizationFields } from "@/components/OrganizationFields";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { requireUser } from "@/server/session";

export const metadata = { title: "Create your organization" };

export default async function OnboardingPage() {
  const user = await requireUser();
  const orgs = await listOrganizationsForUser(user.id);
  return (
    <AuthShell
      title={orgs.length ? "Your organizations" : "Create your organization"}
      subtitle={orgs.length ? undefined : "An organization holds your apps, team and billing. You can add more apps later."}
    >
      {orgs.length > 0 && (
        <ul className="mb-6 space-y-2">
          {orgs.map((o) => (
            <li key={o.id}>
              <Link href={`/o/${o.slug}`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 hover:bg-paper-2">
                <span className="font-medium">{o.name}</span>
                <span className="pill border-line text-ink-3">{o.role}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {orgs.length > 0 && <h2 className="h2 mb-3">New organization</h2>}
      <ActionForm action={createOrganizationAction} submitLabel="Create organization">
        <OrganizationFields />
      </ActionForm>
    </AuthShell>
  );
}
