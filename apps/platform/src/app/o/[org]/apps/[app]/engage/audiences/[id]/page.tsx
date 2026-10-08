import Link from "next/link";
import { audienceLifecycleAction, previewAudienceAction, saveAudienceAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { AudienceEditor } from "@/components/engage/AudienceEditor";
import { fmtDate, knownEvents, knownProperties, Sparkline, StatusPill } from "@/components/engage/shared";
import { NotFoundError } from "@/lib/errors";
import { getAudience } from "@/modules/audiences/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, requirePermission } from "@/server/session";
import { notFound } from "next/navigation";

export const metadata = { title: "Audience" };

export default async function AudiencePage(props: PageProps<"/o/[org]/apps/[app]/engage/audiences/[id]">) {
  const { org, app, id } = await props.params;
  const { ctx, app: project, environments } = await loadApp(org, app);
  requirePermission(ctx, "audiences.read");
  const detail = await getAudience(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { audience: a, history, members, recent } = detail;
  const env = environments.find((e) => e.id === a.environment_id);
  if (!env) notFound();
  const manage = can(ctx.role, "audiences.manage");
  const base = `/o/${org}/apps/${app}/engage/audiences`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}`}>Audiences</Link> / {env.type}</p>
          <h1 className="h1">{a.name} <StatusPill status={a.status} /></h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">{detail.description}</p>
        </div>
        {manage && a.status !== "archived" && (
          <div className="flex gap-2">
            {a.status === "draft" && <ActionForm action={audienceLifecycleAction.bind(null, org, app, a.id, "activate")} submitLabel="Activate" className="space-y-2" />}
            <ActionForm action={audienceLifecycleAction.bind(null, org, app, a.id, "archive")} submitLabel="Archive" buttonClass="btn-danger" className="space-y-2" confirm="Archive this audience? It stops being recomputed." />
          </div>
        )}
      </div>

      {a.status !== "archived" && (can(ctx.role, "analytics.read") || can(ctx.role, "users.read")) && (
        <section className="card flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-ink-2">Use this audience in</span>
          {can(ctx.role, "analytics.read") && (["events", "funnels", "retention", "revenue"] as const).map((r) => (
            <Link key={r} className="underline" href={`/o/${org}/apps/${app}/analytics/${r}?${new URLSearchParams({ env: env.type, cohort: a.id })}`}>{r[0].toUpperCase() + r.slice(1)}</Link>
          ))}
          {can(ctx.role, "users.read") && <Link className="underline" href={`/o/${org}/apps/${app}/analytics/users?${new URLSearchParams({ env: env.type, cohort: a.id })}`}>Users</Link>}
          <span className="text-xs text-ink-3">Reports compute it at the time they run{a.status === "draft" ? ", so a draft works there too" : ""}.</span>
        </section>
      )}

      {a.status !== "draft" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card"><p className="label">People now</p><p className="text-3xl font-bold tabular-nums">{a.member_count.toLocaleString("en-US")}</p></div>
          <div className="card"><p className="label">Last computed</p><p>{fmtDate(a.last_computed_at)}{a.last_compute_ms !== null && <span className="text-ink-3"> · {a.last_compute_ms} ms</span>}</p>
            {a.last_compute_error && <p className="text-sm text-alert">{a.last_compute_error}</p>}</div>
          <div className="card"><p className="label">Recomputed every</p><p>{a.refresh_minutes < 60 ? `${a.refresh_minutes} minutes` : `${a.refresh_minutes / 60} hours`}</p></div>
        </div>
      )}

      {history.length > 0 && (
        <section className="card space-y-2">
          <h2 className="h2">Size history</h2>
          <Sparkline values={history.map((h) => h.member_count)} label={`Audience size over the last ${history.length} computations`} />
          <p className="text-xs text-ink-3">{fmtDate(history[0].computed_at)} – {fmtDate(history.at(-1)!.computed_at)} · last change: +{history.at(-1)!.entered} / −{history.at(-1)!.exited}</p>
        </section>
      )}

      {manage && a.status !== "archived" && (
        <section className="card space-y-3">
          <h2 className="h2">Definition</h2>
          {a.status === "active" && <p className="text-sm text-ink-3">Changing the definition re-baselines membership: people who enter or leave because of the edit don&apos;t trigger automations.</p>}
          <AudienceEditor
            save={saveAudienceAction.bind(null, org, app, a.environment_id, a.id)}
            preview={previewAudienceAction.bind(null, org, a.environment_id)}
            events={await knownEvents(ctx, a.environment_id)}
            properties={await knownProperties(ctx, project.id, a.environment_id)}
            initial={{ name: a.name, description: a.description ?? "", refreshMinutes: a.refresh_minutes, definition: a.definition as never }}
          />
        </section>
      )}

      {a.status !== "draft" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card space-y-2">
            <h2 className="h2">Members (latest 50)</h2>
            {members.length === 0 ? <p className="text-sm text-ink-3">Nobody right now.</p> : (
              <table className="table"><thead><tr><th>Person</th><th>Entered</th></tr></thead>
                <tbody>{members.map((m) => <tr key={m.user_key}><td className="font-mono text-xs break-all">{m.user_key}</td><td className="text-ink-3">{fmtDate(m.entered_at)}</td></tr>)}</tbody>
              </table>
            )}
          </section>
          <section className="card space-y-2">
            <h2 className="h2">Recent changes</h2>
            {recent.length === 0 ? <p className="text-sm text-ink-3">No one has entered or left since activation.</p> : (
              <table className="table"><thead><tr><th>Person</th><th>Change</th><th>When</th></tr></thead>
                <tbody>{recent.map((r, i) => <tr key={i}><td className="font-mono text-xs break-all">{r.user_key}</td><td>{r.kind}</td><td className="text-ink-3">{fmtDate(r.occurred_at)}</td></tr>)}</tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
