import Link from "next/link";
import { revertMappingAction, setMappingHistoryAction } from "@/app/actions/growth";
import { createMappingAction, decideMappingAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { getAppFeatures } from "@/modules/apps/features";
import { listReprocessJobs } from "@/modules/growth/service";
import { implementationReport, listMappingHistory, listMappings } from "@/modules/implementation/service";
import { can } from "@/modules/rbac/authorize";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber, type Lang } from "@/i18n/translate";
import { localizeText } from "@/modules/implementation/localize";
import { loadApp, pickEnvironment } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Validation") };
}

const STATUS_STYLE: Record<string, string> = {
  validated: "border-accent/50 text-accent-ink",
  received: "border-warn/50 text-warn",
  approved: "border-line text-ink-3",
  deprecated: "border-line text-ink-3 line-through",
};
const when = (lang: Lang) => (d: Date | null) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");

export default async function ValidationPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/events">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const env = await pickEnvironment(environments, sp.env);
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
  const t = await getT();
  const lang = await getLang();
  const ago = when(lang);
  const L = (x: string | undefined) => localizeText(x, t, lang);
  const arrow = <span className="inline-block rtl:-scale-x-100">→</span>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Validation")}</h1>
          <p className="mt-1 text-ink-2">
            {report.published ? t("Live events compared with tracking plan v{n}.", { n: report.versionNumber ?? "" }) : t("No tracking plan has been published yet, so there is nothing to validate events against.")}
          </p>
        </div>
      </div>

      {!report.published && (
        <div className="card">
          <p>{t("Publish a tracking plan to get an implementation score and event checks.")}</p>
          <Link href={`${base}/settings/dev-ops/implementation/plan`} className="btn mt-4">{t("Open tracking plan")}</Link>
        </div>
      )}

      {s && (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="card">
            <p className="eyebrow">{t("Implementation score")}</p>
            <p className={`mt-2 text-5xl font-bold ${s.overall >= 80 ? "text-accent-ink" : s.overall >= 50 ? "text-warn" : "text-alert"}`}>{s.overall}%</p>
            <p className="mt-2 text-sm text-ink-2">{t("{validated} of {expected} planned events validated, {implemented} received.", { validated: s.validated, expected: s.expected, implemented: s.implemented })}</p>
            <p className="mt-1 text-xs text-ink-3">{t("Last event: {date}", { date: ago(report.lastEventAt) })}</p>
          </div>
          <div className="card">
            <ul className="space-y-3">
              {s.components.map((c) => (
                <li key={c.key} className="grid grid-cols-[150px_1fr_48px] items-center gap-3 text-sm">
                  <span>{t(c.label)} <span className="text-xs text-ink-3">· {c.weight}%</span></span>
                  <span className="h-2 overflow-hidden rounded-full bg-paper-2" title={L(c.detail)}>
                    {c.score !== null && <span className="block h-full rounded-full bg-accent" style={{ width: `${c.score}%` }} />}
                  </span>
                  <span className="text-end font-mono text-xs">{c.score === null ? t("n/a") : `${c.score}%`}</span>
                  <span className="col-span-3 -mt-2 text-xs text-ink-3">{L(c.detail)}</span>
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
              <p className="font-medium text-alert">{t("Critical events not received yet")}</p>
              <p className="mt-1 font-mono text-xs">{s.missingCritical.join(", ")}</p>
            </div>
          )}
          {s.failing.length > 0 && (
            <div className="rounded-xl border border-warn/40 bg-warn-soft p-4 text-sm">
              <p className="font-medium">{t("Events failing validation")}</p>
              <p className="mt-1 font-mono text-xs">{s.failing.join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {report.events.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-4 pt-4">{t("Planned events")}</h2>
          <table className="table mt-2">
            <thead><tr><th>{t("Event")}</th><th>{t("Priority")}</th><th>{t("Status")}</th><th>{t("Received")}</th><th>{t("Valid")}</th><th>{t("Invalid")}</th><th>{t("Sources")}</th><th>{t("Last seen")}</th></tr></thead>
            <tbody>
              {report.events.map((e) => (
                <tr key={e.event_name}>
                  <td><span className="font-mono">{e.event_name}</span>{e.required && <span className="ms-1 text-xs text-ink-3">{t("required")}</span>}</td>
                  <td className="text-xs">{t(e.priority)}</td>
                  <td><span className={`pill ${STATUS_STYLE[e.status] ?? "border-line"}`}>{e.status === "approved" ? t("not received") : t(e.status)}</span></td>
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
          <h2 className="h2">{t("Unplanned events")}</h2>
          <p className="mb-3 max-w-md text-sm text-ink-3">{t("Received but not in the published plan. Map them to a planned event if they mean the same thing, so they count toward it in your reports.")}</p>
          {report.unplanned.length === 0 ? <p className="text-sm text-ink-3">{t("None.")}</p> : (
            <ul className="space-y-1 text-sm">
              {report.unplanned.map((u) => (
                <li key={u.event_name} className="flex justify-between gap-2"><span className="font-mono">{u.event_name}</span><span className="text-xs text-ink-3">{u.received_count} · {ago(u.last_received_at)}</span></li>
              ))}
            </ul>
          )}
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="h2">{t("Event mappings")}</h2>
            <p className="max-w-md text-sm text-ink-3">{t("An accepted mapping counts an existing event name as the planned one, without any change to your app. Suggestions are never applied until someone on your team reviews and accepts them.")}</p>
          </div>
          {suggested.length > 0 && (
            <ul className="space-y-2">
              {suggested.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
                  <span className="font-mono">{m.from_name}</span><span className="text-ink-3">{arrow}</span><span className="font-mono">{m.to_name}</span>
                  {m.similarity !== null && <span className="text-xs text-ink-3">{t("{n}% match", { n: Math.round(Number(m.similarity) * 100) })}</span>}
                  {canMap && (
                    <span className="ms-auto flex gap-2">
                      <ActionForm action={decideMappingAction.bind(null, org, app, a.id, m.id, true)} submitLabel={t("Accept")} className="contents" />
                      <ActionForm action={decideMappingAction.bind(null, org, app, a.id, m.id, false)} submitLabel={t("Reject")} buttonClass="btn-secondary" className="contents" />
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
                  <span className="font-mono">{m.from_name}</span> {arrow} <span className="font-mono">{m.to_name}</span> <span className="text-xs text-ink-3">{t(m.status)}</span>
                </li>
              ))}
            </ul>
          )}
          {mappings.length === 0 && <p className="text-sm text-ink-3">{t("No mappings yet.")}</p>}
          {canMap && report.published && (
            <ActionForm action={createMappingAction.bind(null, org, app, a.id)} submitLabel={t("Add mapping")} buttonClass="btn-secondary" className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
              <label className="grow"><span className="label">{t("Event your app sends")}</span><input name="from" className="input" placeholder="purchase" required /></label>
              <label className="grow">
                <span className="label">{t("Planned event")}</span>
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
            <h2 className="h2">{t("Mapping history")}</h2>
            <p className="max-w-xl text-sm text-ink-3">{t("Every change to a mapping, with who made it and when. Any revision can be restored, and each change re-maps all past events, not only the last 30 days.")}</p>
          </div>
          {can(ctx.role, "apps.update") && (
            <ActionForm action={setMappingHistoryAction.bind(null, org, app, a.id, !features.mapping_history)} submitLabel={features.mapping_history ? t("Turn off") : t("Turn on mapping history")} buttonClass="btn-secondary" className="contents" />
          )}
        </div>
        {!features.mapping_history && <p className="text-sm text-ink-3">{t("Off for this app. Mappings work as before: a change re-maps the last 30 days (up to 5,000 events).")}</p>}
        {remap && (
          <p className={`text-sm ${remap.status === "failed" ? "text-alert" : "text-ink-2"}`}>
            {t("Re-map of all {env} events ({reason}):", { env: t(env.type), reason: remap.reason })}{" "}
            {remap.status === "done" ? t("finished {date}, {n} events checked", { date: remap.finished_at ? new Date(remap.finished_at).toLocaleString(dateLocale(lang)) : "", n: fmtNumber(remap.done_count) })
              : remap.status === "failed" ? t("failed: {error}", { error: remap.last_error ?? "" })
              : remap.status === "queued" ? t("waiting for the next scheduled run")
              : t("{done} of {total} events", { done: fmtNumber(remap.done_count), total: fmtNumber(remap.total_estimate ?? 0) })}
          </p>
        )}
        {features.mapping_history && (history.length === 0 ? <p className="text-sm text-ink-3">{t("No changes yet.")}</p> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("When")}</th><th>{t("Mapping")}</th><th>{t("Revision")}</th><th>{t("Status")}</th><th>{t("By")}</th><th /></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.mapping_id}:${h.revision}`}>
                    <td className="whitespace-nowrap text-xs text-ink-3">{ago(h.changed_at)}</td>
                    <td><span className="font-mono">{h.from_name}</span> {arrow} <span className="font-mono">{h.to_name}</span></td>
                    <td className="font-mono text-xs">{h.revision}{h.reverted_to ? ` ${t("(restored {n})", { n: h.reverted_to })}` : ""}</td>
                    <td className="text-xs">{t(h.status)}</td>
                    <td className="text-xs text-ink-3">{h.changed_by_email ?? t("LeanApp (suggestion)")}</td>
                    <td>
                      {canMap && currentRevision.get(h.mapping_id) !== h.revision && (
                        <ActionForm action={revertMappingAction.bind(null, org, app, a.id, h.mapping_id, h.revision)} submitLabel={t("Restore")} buttonClass="btn-secondary" className="contents"
                          confirm={t("Restore {from} → {to} ({status})? All past events are re-mapped.", { from: h.from_name, to: h.to_name, status: t(h.status) })} />
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
          <h2 className="h2">{t("Recent validation errors")}</h2>
          <table className="table mt-2">
            <thead><tr><th>{t("When")}</th><th>{t("Event")}</th><th>{t("Problems")}</th></tr></thead>
            <tbody>
              {report.recentErrors.map((r, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-xs text-ink-3">{ago(r.created_at)}</td>
                  <td className="font-mono">{r.event_name}</td>
                  <td className="text-xs">{Array.isArray(r.errors) ? (r.errors as { message?: string }[]).map((x) => x.message).filter(Boolean).map((x) => L(x)).join(lang === "ar" ? "؛ " : "; ") : JSON.stringify(r.errors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
