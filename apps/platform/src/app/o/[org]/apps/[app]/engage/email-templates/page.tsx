import { deleteEmailTemplateAction, saveEmailTemplateAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/components/engage/shared";
import { listEmailTemplates } from "@/modules/messaging/email";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Email templates" };

function Fields({ t }: { t?: { name: string; subject: string; body: string } }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Name</span><input name="name" className="input" defaultValue={t?.name} maxLength={80} required /></label>
        <label className="block"><span className="label">Subject</span><input name="subject" className="input" defaultValue={t?.subject} maxLength={200} required /></label>
      </div>
      <label className="block"><span className="label">Text</span><textarea name="body" className="input min-h-40 py-2" defaultValue={t?.body} maxLength={20_000} required /></label>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Email templates</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Reusable emails for automation email steps in the <strong>{env.type}</strong> environment. Use <code>{"{{user.name}}"}</code> for user properties and <code>{"{{event.item}}"}</code> for the trigger event&apos;s properties. An unsubscribe link and one-click List-Unsubscribe headers are added to every email.
          </p>
        </div>
      </div>

      {manage && (
        <section className="card space-y-3">
          <h2 className="h2">New template</h2>
          <ActionForm action={saveEmailTemplateAction.bind(null, org, app, env.id, null)} submitLabel="Create template" className="space-y-3">
            <Fields />
          </ActionForm>
        </section>
      )}

      {templates.length === 0 ? (
        <p className="text-ink-3">No templates yet.</p>
      ) : (
        templates.map((t) => (
          <section key={t.id} className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="h2">{t.name}</h2>
                <p className="text-sm text-ink-3">Subject: {t.subject} · updated {fmtDate(t.updated_at)}</p>
              </div>
              {manage && <ActionForm action={deleteEmailTemplateAction.bind(null, org, app, t.id)} submitLabel="Delete" buttonClass="btn-danger" confirm={`Delete "${t.name}"?`} />}
            </div>
            {manage ? (
              <details>
                <summary className="cursor-pointer text-sm text-ink-2">Edit</summary>
                <ActionForm action={saveEmailTemplateAction.bind(null, org, app, env.id, t.id)} submitLabel="Save" className="mt-3 space-y-3">
                  <Fields t={t} />
                </ActionForm>
              </details>
            ) : <pre className="whitespace-pre-wrap rounded-lg bg-paper-2 p-3 text-sm">{t.body}</pre>}
          </section>
        ))
      )}
    </div>
  );
}
