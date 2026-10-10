import Link from "next/link";
import { saveCampaignAction } from "@/app/actions/campaigns";
import { campaignTestAction, checkCampaignAction } from "@/app/actions/messaging";
import { composerContext } from "@/components/engage/composer-context";
import { CampaignForm } from "@/components/engage/CampaignForm";
import { getT } from "@/i18n/server";
import { listAudiences } from "@/modules/audiences/service";
import { listEmailTemplates } from "@/modules/messaging/email";
import { getOrganization } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { listTemplates } from "@/modules/whatsapp/service";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("New campaign") };
}

export default async function NewCampaignPage(props: PageProps<"/o/[org]/apps/[app]/engage/campaigns/new">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: project, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.manage");
  const env = await pickEnvironment(environments, sp.env);
  const [audiences, organization, whatsappTemplates, emailTemplates, composer] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id) : Promise.resolve([]),
    getOrganization(ctx),
    listTemplates(ctx, env.id),
    listEmailTemplates(ctx, env.id),
    composerContext(ctx, project.id, env.id),
  ]);
  const t = await getT();
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-3"><Link className="hover:underline" href={`/o/${org}/apps/${app}/engage/campaigns?env=${env.type}`}>{t("Campaigns")}</Link> / {t("new")}</p>
        <h1 className="h1">{t("New campaign")} <span className="pill border-line align-middle text-xs">{env.type}</span></h1>
      </div>
      <section className="card">
        <CampaignForm action={saveCampaignAction.bind(null, org, app, env.id, null)} name="" initial={{}} submitLabel={t("Save draft")}
          audiences={audiences} emailTemplates={emailTemplates} whatsappTemplates={whatsappTemplates} timezone={organization.timezone}
          connected={composer.connected} userProperties={composer.userProperties} checkAction={checkCampaignAction.bind(null, org, env.id)} testAction={campaignTestAction.bind(null, org, env.id)} />
      </section>
    </div>
  );
}
