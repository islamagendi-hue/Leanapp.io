import { archiveAppAction, restoreAppAction, updateAppAction } from "@/app/actions/apps";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { loadApp } from "@/server/session";

export const metadata = { title: "Project settings" };

/** A project's name and description, and its lifecycle (archive and restore). */
export default async function ProjectGeneralPage(props: PageProps<"/o/[org]/apps/[app]/settings/project">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  const archived = a.status === "archived";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Project</h1>
        <p className="mt-1 text-ink-2">
          URL: <span className="font-mono text-sm">/apps/{a.slug}</span>. Renaming keeps the URL and every SDK key as they are.
        </p>
      </div>

      <section className="card max-w-2xl">
        <h2 className="h2 mb-4">General</h2>
        {can(ctx.role, "apps.update") ? (
          <ActionForm action={updateAppAction.bind(null, org, a.id)} submitLabel="Save changes" pendingLabel="Saving…">
            <div>
              <label className="label" htmlFor="name">Project name</label>
              <input className="input" id="name" name="name" required minLength={2} maxLength={80} defaultValue={a.name} />
            </div>
            <div>
              <label className="label" htmlFor="description">Description <span className="muted">(optional)</span></label>
              <input className="input" id="description" name="description" maxLength={500} defaultValue={a.description ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="category">Category <span className="muted">(optional)</span></label>
              <input className="input" id="category" name="category" maxLength={60} placeholder="Food delivery" defaultValue={a.category ?? ""} />
            </div>
          </ActionForm>
        ) : (
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-ink-3">Name</dt><dd>{a.name}</dd>
            <dt className="text-ink-3">Description</dt><dd>{a.description ?? "–"}</dd>
            <dt className="text-ink-3">Category</dt><dd>{a.category ?? "–"}</dd>
            <dt className="text-ink-3">Platforms</dt><dd>{a.platforms.join(", ") || "–"}</dd>
          </dl>
        )}
      </section>

      <section className="card max-w-2xl">
        <h2 className="h2">{archived ? "Archived" : "Archive project"}</h2>
        {archived ? (
          <p className="mt-1 text-sm text-ink-2">
            This project is archived. Its SDK keys are refused, so it receives no events, and it doesn&apos;t count toward your plan. Its data and reports are kept.
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-2">
            Archiving stops the project receiving events (its SDK keys are refused), hides it from the project list and frees its place on your plan. Data, reports and settings are kept, and an owner or admin can restore it.
          </p>
        )}
        {can(ctx.role, "apps.delete") ? (
          archived ? (
            <ActionForm action={restoreAppAction.bind(null, org, a.id)} submitLabel="Restore project" pendingLabel="Restoring…" className="mt-4 space-y-3" />
          ) : (
            <ActionForm
              action={archiveAppAction.bind(null, org, a.id)}
              submitLabel="Archive project"
              pendingLabel="Archiving…"
              className="mt-4 space-y-3"
              buttonClass="btn-danger"
              confirm={`Archive ${a.name}? It stops receiving events until it is restored.`}
            />
          )
        ) : (
          <p className="mt-3 text-sm text-ink-3">Only owners and admins can {archived ? "restore" : "archive"} a project.</p>
        )}
      </section>
    </div>
  );
}
