import Link from "next/link";
import { revertMappingAction, setMappingHistoryAction } from "@/app/actions/growth";
import { createMappingAction, decideMappingAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { getAppFeatures } from "@/modules/apps/features";
import { listReprocessJobs } from "@/modules/growth/service";
import { implementationReport, listMappingHistory, listMappings } from "@/modules/implementation/service";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment } from "@/server/session";

export const metadata = { title: "Validation" };

const STATUS_STYLE: Record<string, string> = {
  validated: "border-accent/50 text-accent-ink",
  received: "border-warn/50 text-warn",
  approved: "border-line text-ink-3",
  deprecated: "border-line text-ink-3 line-through",
};
const ago = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "–");

export default async function ValidationPage(props: PageProps<"/o/[org]/apps/[app]/implementation/validation">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const env = pickEnvironment(environments, sp.env);
  const report = await implementationReport(ctx, a.id, env.id);
  const mappings = await listMappings(ctx, a.id);
  const canMap = can(ctx.role, "implementation.mapping");
  const features = await getAppFeatures(ctx, a.id);
  const history = features.mapping_history ? await listMappingHistory(ctx, a.id, { limit: 50 }) : [];
  const remap = features.mapping_history ? (await listReprocessJobs(ctx, a.id)).find((j) => j.kind === "remap" && j.environment_id === env.id) : undefined;
  const currentRevision = new Map<string, number>();
  for (const h of history) if (!currentRevision.has(h.mapping_id)) currentRevision.set(h.mapping_id, h.revision);
  const base = `/o/${org}/apps/${app}`;
  const suggested = mappings.filter((m) => m.status === "suggested");
  const decided = mappings.filter((m) => m.status !== "suggested");
  const s = report.score;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Validation</h1>
          <p className="mt-1 text-ink-2">
            {report.published ? `Live events compared with tracking plan v${report.versionNumber}.` : "No published tracking plan yet, so nothing to validate against."}
          </p>
        </div>
        <EnvSwitcher path={`${base}/implementation/validation`} current={env.type} />
      </div>

      {!report.published && (
        <div className="card">
          <p>Publish a tracking plan to get an implementation score and per-event validation.</p>
          <Link href={`${base}/implementation/plan`} className="btn mt-4">Open tracking plan</Link>
        </div>
      )}

      {s && (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="card">
            <p className="font-mono text-xs uppercase tracking-wide text-ink-3">Implementation score</p>
            <p className={`mt-2 text-5xl font-bold ${s.overall >= 80 ? "text-accent-ink" : s.overall >= 50 ? "text-warn" : "text-alert"}`}>{s.overall}%</p>
            <p className="mt-2 text-sm text-ink-2">{s.validated} of {s.expected} planned events validated, {s.implemented} received.</p>
            <p className="mt-1 text-xs text-ink-3">Last event: {ago(report.lastEventAt)}</p>
          </div>
          <div className="card">
            <ul className="space-y-3">
              {s.components.map((c) => (
                <li key={c.key} className="grid grid-cols-[150px_1fr_48px] items-center gap-3 text-sm">
                  <span>{c.label} <span className="text-xs text-ink-3">· {c.weight}%</span></span>
                  <span className="h-2 overflow-hidden rounded-full bg-paper-2" title={c.detail}>
                    {c.score !== null && <span className="block h-full rounded-full bg-accent" style={{ width: `${c.score}%` }} />}
                  </span>
                  <span className="text-end font-mono text-xs">{c.score === null ? "n/a" : `${c.score}%`}</span>
                  <span className="col-span-3 -mt-2 text-xs text-ink-3">{c.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {s && (s.missingCritical.length > 0 || s.failing.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {s.missingCritical.length > 0 && (
            <div className="rounded-xl border border-alert/40 bg-alert-soft p-4 text-sm">
              <p className="font-medium text-alert">Critical events not received yet</p>
              <p className="mt-1 font-mono text-xs">{s.missingCritical.join(", ")}</p>
            </div>
          )}
          {s.failing.length > 0 && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-4 text-sm">
              <p className="font-medium">Events failing validation</p>
              <p className="mt-1 font-mono text-xs">{s.failing.join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {report.events.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-4 pt-4">Planned events</h2>
          <table className="table mt-2">
            <thead><tr><th>Event</th><th>Priority</th><th>Status</th><th>Received</th><th>Valid</th><th>Invalid</th><th>Sources</th><th>Last seen</th></tr></thead>
            <tbody>
              {report.events.map((e) => (
                <tr key={e.event_name}>
                  <td><span className="font-mono">{e.event_name}</span>{e.required && <span className="ms-1 text-xs text-ink-3">required</span>}</td>
                  <td className="text-xs">{e.priority}</td>
                  <td><span className={`pill ${STATUS_STYLE[e.status] ?? "border-line"}`}>{e.status === "approved" ? "not received" : e.status}</span></td>
                  <td className="font-mono">{e.received_count}</td>
                  <td className="font-mono">{e.valid_count}</td>
                  <td className={`font-mono ${e.invalid_count ? "text-alert" : ""}`}>{e.invalid_count}</td>
                  <td className="text-xs text-ink-2">{e.sources.join(", ") || "–"}</td>
                  <td className="whitespace-nowrap text-xs text-ink-3">{ago(e.last_received_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="card">
          <h2 className="h2">Unplanned events</h2>
          <p className="mb-3 text-sm text-ink-3">Received but not in the published plan. Map them to a planned event if they mean the same thing.</p>
          {report.unplanned.length === 0 ? <p className="text-sm text-ink-3">None.</p> : (
            <ul className="space-y-1 text-sm">
              {report.unplanned.map((u) => (
                <li key={u.event_name} className="flex justify-between gap-2"><span className="font-mono">{u.event_name}</span><span className="text-xs text-ink-3">{u.received_count} · {ago(u.last_received_at)}</span></li>
              ))}
            </ul>
          )}
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="h2">Event mappings</h2>
            <p className="text-sm text-ink-3">An accepted mapping counts an existing event name as the planned one, without changing your app. Suggestions are never applied until someone accepts them.</p>
          </div>
          {suggested.length > 0 && (
            <ul className="space-y-2">
              {suggested.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
                  <span className="font-mono">{m.from_name}</span><span className="text-ink-3">→</span><span className="font-mono">{m.to_name}</span>
                  {m.similarity !== null && <span className="text-xs text-ink-3">{Math.round(Number(m.similarity) * 100)}% match</span>}
                  {canMap && (
                    <span className="ms-auto flex gap-2">
                      <ActionForm action={decideMappingAction.bind(null, org, app, a.id, m.id, true)} submitLabel="Accept" className="contents" />
                      <ActionForm action={decideMappingAction.bind(null, org, app, a.id, m.id, false)} submitLabel="Reject" buttonClass="btn-secondary" className="contents" />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {decided.length > 0 && (
            <ul className="space-y-1 text-sm">
              {decided.map((m) => (
                <li key={m.id} className={m.status === "rejected" ? "text-ink-3 line-through" : ""}>
                  <span className="font-mono">{m.from_name}</span> → <span className="font-mono">{m.to_name}</span> <span className="text-xs text-ink-3">{m.status}</span>
                </li>
              ))}
            </ul>
          )}
          {mappings.length === 0 && <p className="text-sm text-ink-3">No mappings yet.</p>}
          {canMap && report.published && (
            <ActionForm action={createMappingAction.bind(null, org, app, a.id)} submitLabel="Add mapping" buttonClass="btn-secondary" className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
              <label className="grow"><span className="label">Event your app sends</span><input name="from" className="input" placeholder="purchase" required /></label>
              <label className="grow">
                <span className="label">Planned event</span>
                <select name="to" className="input" required>
                  {report.events.map((e) => <option key={e.event_name} value={e.event_name}>{e.event_name}</option>)}
                </select>
              </label>
            </ActionForm>
          )}
        </div>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="h2">Mapping history</h2>
            <p className="text-sm text-ink-3">Every change to a mapping, with who made it. Any revision can be restored, and each change re-maps all past events, not only the last 30 days.</p>
          </div>
          {can(ctx.role, "apps.update") && (
            <ActionForm action={setMappingHistoryAction.bind(null, org, app, a.id, !features.mapping_history)} submitLabel={features.mapping_history ? "Turn off" : "Turn on mapping history"} buttonClass="btn-secondary" className="contents" />
          )}
        </div>
        {!features.mapping_history && <p className="text-sm text-ink-3">Off for this app. Mappings work as before: a change re-maps the last 30 days (up to 5,000 events).</p>}
        {remap && (
          <p className={`text-sm ${remap.status === "failed" ? "text-alert" : "text-ink-2"}`}>
            Re-map of all {env.type} events ({remap.reason}):{" "}
            {remap.status === "done" ? `finished ${remap.finished_at ? new Date(remap.finished_at).toLocaleString("en-GB") : ""}, ${remap.done_count.toLocaleString("en-GB")} events checked`
              : remap.status === "failed" ? `failed: ${remap.last_error}`
              : remap.status === "queued" ? "waiting for the next scheduled run"
              : `${remap.done_count.toLocaleString("en-GB")} of ${(remap.total_estimate ?? 0).toLocaleString("en-GB")} events`}
          </p>
        )}
        {features.mapping_history && (history.length === 0 ? <p className="text-sm text-ink-3">No changes yet.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>When</th><th>Mapping</th><th>Revision</th><th>Status</th><th>By</th><th /></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.mapping_id}:${h.revision}`}>
                    <td className="whitespace-nowrap text-xs text-ink-3">{ago(h.changed_at)}</td>
                    <td><span className="font-mono">{h.from_name}</span> → <span className="font-mono">{h.to_name}</span></td>
                    <td className="font-mono text-xs">{h.revision}{h.reverted_to ? ` (restored ${h.reverted_to})` : ""}</td>
                    <td className="text-xs">{h.status}</td>
                    <td className="text-xs text-ink-3">{h.changed_by_email ?? "LeanApp (suggestion)"}</td>
                    <td>
                      {canMap && currentRevision.get(h.mapping_id) !== h.revision && (
                        <ActionForm action={revertMappingAction.bind(null, org, app, a.id, h.mapping_id, h.revision)} submitLabel="Restore" buttonClass="btn-secondary" className="contents"
                          confirm={`Restore ${h.from_name} → ${h.to_name} (${h.status})? All past events are re-mapped.`} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {report.recentErrors.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="h2">Recent validation errors</h2>
          <table className="table mt-2">
            <thead><tr><th>When</th><th>Event</th><th>Problems</th></tr></thead>
            <tbody>
              {report.recentErrors.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-xs text-ink-3">{ago(r.created_at)}</td>
                  <td className="font-mono">{r.event_name}</td>
                  <td className="text-xs">{Array.isArray(r.errors) ? (r.errors as { message?: string }[]).map((x) => x.message).filter(Boolean).join("; ") : JSON.stringify(r.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
