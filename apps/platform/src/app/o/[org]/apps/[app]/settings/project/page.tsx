import { archiveAppAction, restoreAppAction, updateAppAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Project settings") };
}

/** A project's name and description, and its lifecycle (archive and restore). */
export default async function ProjectGeneralPage(props: PageProps<"/o/[org]/apps/[app]/settings/project">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  const archived = a.status === "archived";
  const t = await getT();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Project")}</h1>
        <p className="mt-1 text-ink-2">
          {t("URL:")} <span dir="ltr" className="font-mono text-sm">/apps/{a.slug}</span>. {t("Renaming keeps the URL and every SDK key as they are.")}
        </p>
      </div>

      <section className="card max-w-2xl">
        <h2 className="h2 mb-4">{t("General")}</h2>
        {can(ctx.role, "apps.update") ? (
          <ActionForm action={updateAppAction.bind(null, org, a.id)} submitLabel={t("Save changes")} pendingLabel={t("Saving…")}>
            <div>
              <label className="label" htmlFor="name">{t("Project name")}</label>
              <input className="input" id="name" name="name" required minLength={2} maxLength={80} defaultValue={a.name} />
            </div>
            <div>
              <label className="label" htmlFor="description">{t("Description")} <span className="muted">{t("(optional)")}</span></label>
              <input className="input" id="description" name="description" maxLength={500} defaultValue={a.description ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="category">{t("Category")} <span className="muted">{t("(optional)")}</span></label>
              <input className="input" id="category" name="category" maxLength={60} placeholder={t("Food delivery")} defaultValue={a.category ?? ""} />
            </div>
          </ActionForm>
        ) : (
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-ink-3">{t("Name")}</dt><dd>{a.name}</dd>
            <dt className="text-ink-3">{t("Description")}</dt><dd>{a.description ?? "–"}</dd>
            <dt className="text-ink-3">{t("Category")}</dt><dd>{a.category ?? "–"}</dd>
            <dt className="text-ink-3">{t("Platforms")}</dt><dd>{a.platforms.join(", ") || "–"}</dd>
          </dl>
        )}
      </section>

      <section className="card max-w-2xl">
        <h2 className="h2">{archived ? t("Archived") : t("Archive project")}</h2>
        {archived ? (
          <p className="mt-1 text-sm text-ink-2">
            {t("This project is archived. Its SDK keys are refused, so it receives no events, and it doesn't count toward your plan. Its data and reports are kept.")}
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            {t("Archiving stops the project receiving events (its SDK keys are refused), hides it from the project list and frees its place on your plan. Data, reports and settings are kept, and an owner or admin can restore it.")}
          </p>
        )}
        {can(ctx.role, "apps.delete") ? (
          archived ? (
            <ActionForm action={restoreAppAction.bind(null, org, a.id)} submitLabel={t("Restore project")} pendingLabel={t("Restoring…")} className="mt-4 space-y-3" />
          ) : (
            <ActionForm
              action={archiveAppAction.bind(null, org, a.id)}
              submitLabel={t("Archive project")}
              pendingLabel={t("Archiving…")}
              className="mt-4 space-y-3"
              buttonClass="btn-danger"
              confirm={t("Archive {name}? It stops receiving events until it is restored.", { name: a.name })}
            />
          )
        ) : (
          <p className="mt-3 text-sm text-ink-3">{archived ? t("Only owners and admins can restore a project.") : t("Only owners and admins can archive a project.")}</p>
        )}
      </section>
    </div>
  );
}
