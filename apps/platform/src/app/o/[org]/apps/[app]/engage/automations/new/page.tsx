import Link from "next/link";
import { saveAutomationAction } from "@/app/actions/engage";
import { AutomationEditor, DEFAULT_DEFINITION } from "@/components/engage/AutomationEditor";
import { knownEvents, knownProperties } from "@/components/engage/shared";
import { listAudiences } from "@/modules/audiences/service";
import { getOrganization } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { listEmailTemplates } from "@/modules/messaging/email";
import { listWebhookTargets } from "@/modules/webhooks/service";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "New flow" };

export default async function NewAutomationPage(props: PageProps<"/o/[org]/apps/[app]/engage/automations/new">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: project, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.manage");
  const env = await pickEnvironment(environments, sp.env);
  const [events, properties, audiences, webhooks, organization, whatsappTemplates, emailTemplates] = await Promise.all([
    knownEvents(ctx, env.id),
    knownProperties(ctx, project.id, env.id),
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id) : Promise.resolve([]),
    listWebhookTargets(ctx, env.id),
    getOrganization(ctx),
    listTemplates(ctx, env.id),
    listEmailTemplates(ctx, env.id),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-3"><Link className="hover:underline" href={`/o/${org}/apps/${app}/engage/automations?env=${env.type}`}>Flows</Link> / new</p>
        <h1 className="h1">New flow <span className="pill border-line align-middle text-xs">{env.type}</span></h1>
      </div>
      <section className="card">
        <AutomationEditor save={saveAutomationAction.bind(null, org, app, env.id, null)} initial={DEFAULT_DEFINITION} name=""
          events={events} properties={properties} audiences={audiences} webhooks={webhooks} timezone={organization.timezone}
          whatsappTemplates={whatsappTemplates} emailTemplates={emailTemplates} />
      </section>
      <p className="text-sm text-ink-3">Saved as a draft. Activate it from its page when you&apos;re ready.</p>
    </div>
  );
}
