import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { automationLifecycleAction, saveAutomationAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { AutomationEditor } from "@/components/engage/AutomationEditor";
import { FlowView } from "@/components/engage/FlowView";
import { fmtDate, knownEvents, knownProperties, StatusPill } from "@/components/engage/shared";
import { NotFoundError } from "@/lib/errors";
import { listAudiences } from "@/modules/audiences/service";
import { describeTrigger } from "@/modules/automation/definition";
import { getAutomation, goalReport } from "@/modules/automation/service";
import { listEmailTemplates } from "@/modules/messaging/email";
import { listIntegrations } from "@/modules/messaging/integrations";
import { listTemplates } from "@/modules/whatsapp/service";
import { getOrganization } from "@/modules/organizations/service";
import { can } from "@/modules/rbac/authorize";
import { listWebhookTargets } from "@/modules/webhooks/service";
import { loadApp, requirePermission } from "@/server/session";

export const metadata = { title: "Automation" };

const RUN_STATUSES = ["pending", "waiting", "running", "completed", "failed", "cancelled"];

export default async function AutomationPage(props: PageProps<"/o/[org]/apps/[app]/engage/automations/[id]">) {
  const { org, app, id } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: project, environments } = await loadApp(org, app);
  requirePermission(ctx, "automations.read");
  const runStatus = typeof sp.runs === "string" && RUN_STATUSES.includes(sp.runs) ? sp.runs : undefined;
  const { automation: a, versions, runs } = await getAutomation(ctx, id, { runStatus }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  // Campaigns run on the same engine but have their own page.
  if (a.kind === "campaign") redirect(`/o/${org}/apps/${app}/engage/campaigns/${a.id}`);
  const env = environments.find((e) => e.id === a.environment_id);
  if (!env) notFound();
  const manage = can(ctx.role, "automations.manage");
  const [audiences, webhooks, organization, integrations, events, properties, whatsappTemplates, emailTemplates, goal] = await Promise.all([
    can(ctx.role, "audiences.read") ? listAudiences(ctx, env.id, { includeArchived: true }) : Promise.resolve([]),
    listWebhookTargets(ctx, env.id),
    getOrganization(ctx),
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, env.id) : Promise.resolve(null),
    manage ? knownEvents(ctx, env.id) : Promise.resolve([]),
    manage ? knownProperties(ctx, project.id, env.id) : Promise.resolve(undefined),
    manage ? listTemplates(ctx, env.id) : Promise.resolve([]),
    manage ? listEmailTemplates(ctx, env.id) : Promise.resolve([]),
    goalReport(ctx, a.id),
  ]);
  const audienceName = (aid: string) => audiences.find((x) => x.id === aid)?.name ?? "an audience";
  const base = `/o/${org}/apps/${app}/engage/automations`;
  const def = a.definition;
  const needs = (p: string) => integrations !== null && !integrations.some((i) => i.provider === p);
  const missing = [
    def.steps.some((s) => s.type === "push") && needs("fcm") && needs("apns") ? "push (FCM or APNs)" : null,
    def.steps.some((s) => s.type === "email") && needs("resend") ? "email (Resend)" : null,
    def.steps.some((s) => s.type === "whatsapp") && needs("whatsapp") ? "WhatsApp" : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-3"><Link className="hover:underline" href={`${base}?env=${env.type}`}>Flows</Link> / {env.type}</p>
          <h1 className="h1">{a.name} <StatusPill status={a.status} /> <span className="text-base font-normal text-ink-3">v{a.version}</span></h1>
          <p className="mt-1 text-sm text-ink-2">{describeTrigger(def.trigger, audienceName)}{a.next_fire_at && a.status === "active" ? ` · next ${fmtDate(a.next_fire_at)}` : ""}</p>
        </div>
        {manage && a.status !== "archived" && (
          <div className="flex flex-wrap gap-2">
            {(a.status === "draft" || a.status === "paused") && <ActionForm action={automationLifecycleAction.bind(null, org, app, a.id, "activate")} submitLabel={a.status === "paused" ? "Resume" : "Activate"} className="space-y-2" />}
            {a.status === "active" && <ActionForm action={automationLifecycleAction.bind(null, org, app, a.id, "pause")} submitLabel="Pause" buttonClass="btn-secondary" className="space-y-2" />}
            <ActionForm action={automationLifecycleAction.bind(null, org, app, a.id, "archive")} submitLabel="Archive" buttonClass="btn-danger" className="space-y-2" confirm="Archive this automation? Runs in progress are cancelled." />
          </div>
        )}
      </div>

      {missing.length > 0 && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Not connected in {env.type}: {missing.join(", ")}. Those steps will be logged as failed until you connect them in <Link className="underline" href={`/o/${org}/apps/${app}/settings/dev-ops/channels?env=${env.type}`}>Integrations</Link>.
        </p>
      )}

      {goal && (
        <section className="card space-y-3" aria-label="Goal">
          <h2 className="h2">Goal: {goal.goal.event} within {goal.goal.withinDays} days</h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div><dt className="text-xs text-ink-3">Entered</dt><dd className="text-xl font-semibold tabular-nums">{goal.entered}</dd></div>
            <div><dt className="text-xs text-ink-3">Converted</dt><dd className="text-xl font-semibold tabular-nums">{goal.converted}</dd></div>
            <div><dt className="text-xs text-ink-3">Conversion rate</dt><dd className="text-xl font-semibold tabular-nums">{goal.entered ? `${((goal.converted / goal.entered) * 100).toFixed(1)}%` : "–"}</dd></div>
            <div><dt className="text-xs text-ink-3">Still in window</dt><dd className="text-xl font-semibold tabular-nums">{goal.open}</dd></div>
            <div><dt className="text-xs text-ink-3">Median time to convert</dt><dd className="text-xl font-semibold tabular-nums">{goal.medianSeconds === null ? "–" : goal.medianSeconds < 3600 ? `${Math.round(goal.medianSeconds / 60)} min` : `${(goal.medianSeconds / 3600).toFixed(1)} h`}</dd></div>
          </dl>
          <p className="text-xs text-ink-3">
            From your event stream: a person converts when they do {goal.goal.event} after their trigger and within {goal.goal.withinDays} days.
            {goal.goal.stopOnConversion ? ` ${goal.stopped} runs stopped early because the person converted.` : " Runs continue after conversion."} There is no control group, so this shows who converted, not how many converted because of the flow.
          </p>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="h2">Flow (v{a.version})</h2>
        <FlowView definition={def} audienceName={audienceName} />
        <p className="text-xs text-ink-3">
          Entry: {def.entry.mode === "once" ? "once per person" : `each trigger${def.entry.cooldownHours ? `, at most every ${def.entry.cooldownHours} h` : ""}`} ·
          Cap: {def.frequencyCap ? `${def.frequencyCap.messages} messages / ${def.frequencyCap.hours} h` : "none"} ·
          Quiet hours: {def.quietHours ? `${def.quietHours.start}–${def.quietHours.end} ${organization.timezone}` : "none"}
          {def.exitEvent ? ` · Exit event: ${def.exitEvent}` : ""}
        </p>
      </section>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="h2">Runs</h2>
          <nav className="flex flex-wrap gap-2 text-xs">
            {[undefined, ...RUN_STATUSES].map((s) => (
              <Link key={s ?? "all"} href={s ? `?runs=${s}` : "?"} className={`pill ${runStatus === s ? "border-ink bg-ink text-paper" : "border-line"}`}>{s ?? "all"}</Link>
            ))}
          </nav>
        </div>
        <p className="text-xs text-ink-3">In progress {a.runs.active} · completed {a.runs.completed} · failed {a.runs.failed} · total {a.runs.total}</p>
        {runs.length === 0 ? <p className="text-sm text-ink-3">No runs{runStatus ? ` with status ${runStatus}` : ""}.</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Person</th><th>Status</th><th>Step</th><th>Started</th><th>Next</th><th>Log</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs break-all">{r.user_key}</td>
                    <td><StatusPill status={r.status} />{r.version !== a.version && <span className="ms-1 text-xs text-ink-3">v{r.version}</span>}</td>
                    <td className="tabular-nums">{Math.min(r.current_step + 1, def.steps.length)}</td>
                    <td className="text-ink-3">{fmtDate(r.started_at)}</td>
                    <td className="text-ink-3">{["pending", "waiting"].includes(r.status) ? fmtDate(r.next_run_at) : "–"}</td>
                    <td>
                      <details>
                        <summary className="cursor-pointer text-xs text-ink-2">{r.log.length} entries</summary>
                        <ol className="mt-2 space-y-1 text-xs">
                          {r.log.map((l, i) => (
                            <li key={i} className={l.outcome === "failed" ? "text-alert" : l.outcome === "skipped" ? "text-warn" : ""}>
                              <span className="text-ink-3">{fmtDate(l.at)}</span> {l.step !== null && <>step {l.step + 1} · </>}<strong>{l.type}</strong> {l.outcome}{l.detail ? `: ${l.detail}` : ""}
                            </li>
                          ))}
                        </ol>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {manage && a.status !== "archived" && (
        <section className="card space-y-3">
          <h2 className="h2">Edit</h2>
          <p className="text-sm text-ink-3">Saving creates version {a.version + 1}. Runs in progress finish on the version they started with{a.status === "active" ? "; a changed trigger starts from now" : ""}.</p>
          <AutomationEditor save={saveAutomationAction.bind(null, org, app, env.id, a.id)} initial={def as never} name={a.name}
            events={events} properties={properties} audiences={audiences.filter((x) => x.status !== "archived")} webhooks={webhooks} timezone={organization.timezone}
            whatsappTemplates={whatsappTemplates} emailTemplates={emailTemplates} />
        </section>
      )}

      <section className="card space-y-2">
        <h2 className="h2">Versions</h2>
        <ul className="text-sm">{versions.map((v) => <li key={v.version}>v{v.version} · {fmtDate(v.created_at)}{v.created_by_name ? ` · ${v.created_by_name}` : ""}</li>)}</ul>
      </section>
    </div>
  );
}
