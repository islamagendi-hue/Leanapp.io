import { deleteEmailTemplateAction, saveEmailTemplateAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { getLang, getT } from "@/i18n/server";
import { listEmailTemplates } from "@/modules/messaging/email";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Email templates") };
}

async function Fields({ tpl }: { tpl?: { name: string; subject: string; body: string } }) {
  const t = await getT();
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">{t("Name")}</span><input name="name" className="input" defaultValue={tpl?.name} maxLength={80} required /></label>
        <label className="block"><span className="label">{t("Subject")}</span><input name="subject" className="input" defaultValue={tpl?.subject} maxLength={200} required /></label>
      </div>
      <label className="block"><span className="label">{t("Text")}</span><textarea name="body" className="input min-h-40 py-2" defaultValue={tpl?.body} maxLength={20_000} required /></label>
    </>
  );
}

export default async function EmailTemplatesPage(props: PageProps<"/o/[org]/apps/[app]/engage/email-templates">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const env = await pickEnvironment(environments, sp.env);
  const templates = await listEmailTemplates(ctx, env.id);
  const manage = can(ctx.role, "automations.manage");
  const [t, lang] = await Promise.all([getT(), getLang()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Email templates")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {t("Reusable emails for automation email steps in the {env} environment. Use {user} for user properties and {event} for the trigger event's properties. An unsubscribe link and one-click List-Unsubscribe headers are added to every email.", { env: t(env.type), user: "{{user.name}}", event: "{{event.item}}" })}
          </p>
        </div>
      </div>

      {manage && (
        <section className="card space-y-3">
          <h2 className="h2">{t("New template")}</h2>
          <ActionForm action={saveEmailTemplateAction.bind(null, org, app, env.id, null)} submitLabel={t("Create template")} className="space-y-3">
            <Fields />
          </ActionForm>
        </section>
      )}

      {templates.length === 0 ? (
        <p className="text-ink-3">{t("No templates yet.")}</p>
      ) : (
        templates.map((tpl) => (
          <section key={tpl.id} className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="h2">{tpl.name}</h2>
                <p className="text-sm text-ink-3">{t("Subject: {subject} · updated {date}", { subject: tpl.subject, date: fmtDate(tpl.updated_at, lang) })}</p>
              </div>
              {manage && <ActionForm action={deleteEmailTemplateAction.bind(null, org, app, tpl.id)} submitLabel={t("Delete")} buttonClass="btn-danger" confirm={t('Delete "{name}"?', { name: tpl.name })} />}
            </div>
            {manage ? (
              <details>
                <summary className="cursor-pointer text-sm text-ink-2">{t("Edit")}</summary>
                <ActionForm action={saveEmailTemplateAction.bind(null, org, app, env.id, tpl.id)} submitLabel={t("Save")} className="mt-3 space-y-3">
                  <Fields tpl={tpl} />
                </ActionForm>
              </details>
            ) : <pre className="whitespace-pre-wrap rounded-lg bg-paper-2 p-3 text-sm">{tpl.body}</pre>}
          </section>
        ))
      )}
    </div>
  );
}
