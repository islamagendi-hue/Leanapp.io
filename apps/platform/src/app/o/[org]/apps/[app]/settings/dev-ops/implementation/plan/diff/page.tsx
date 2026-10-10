import Link from "next/link";
import { diffPlanVersions } from "@/modules/implementation/editor";
import type { FieldChange, NamedChange } from "@/modules/implementation/diff";
import { listVersions } from "@/modules/implementation/service";
import { getT } from "@/i18n/server";
import { loadApp } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Compare plan versions") };
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : Array.isArray(v) ? v.join(", ") || "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

function Changes({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="space-y-0.5 text-xs">
      {changes.map((c) => (
        <li key={c.field}>
          <span className="font-mono text-ink-3">{c.field}</span>: <del className="text-alert">{show(c.from)}</del> <span aria-hidden className="inline-block rtl:-scale-x-100">→</span> <ins className="text-accent-ink no-underline">{show(c.to)}</ins>
        </li>
      ))}
    </ul>
  );
}

function NamedChanges({ title, items }: { title: string; items: NamedChange[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs text-ink-3">{title}</p>
      <ul className="mt-1 space-y-2">
        {items.map((c) => <li key={c.name}><span className="font-mono text-sm">{c.name}</span><Changes changes={c.changes} /></li>)}
      </ul>
    </div>
  );
}

export default async function DiffPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/implementation/plan/diff">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a } = await loadApp(org, app);
  const versions = await listVersions(ctx, a.id);
  const base = `/o/${org}/apps/${app}/settings/dev-ops/implementation/plan`;
  const to = typeof sp.to === "string" ? sp.to : versions[0]?.id;
  const toVersion = versions.find((v) => v.id === to);
  const from = typeof sp.from === "string" ? sp.from : toVersion?.based_on_version_id ?? versions.find((v) => v.id !== to)?.id;
  const t = await getT();
  const diff = from && to && from !== to && versions.some((v) => v.id === from) && toVersion ? await diffPlanVersions(ctx, a.id, from, to) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href={base} className="text-sm text-ink-3"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {t("Tracking plan")}</Link>
        <h1 className="h1 mt-1">{t("Compare versions")}</h1>
      </div>
      {versions.length < 2 ? (
        <p className="card text-ink-2">{t("There is only one version so far. Edit the plan or regenerate it to create another.")}</p>
      ) : (
        <form className="card flex flex-wrap items-end gap-3" method="get">
          <div>
            <label className="label" htmlFor="from">{t("From")}</label>
            <select className="input w-auto" id="from" name="from" defaultValue={from}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {t(v.status)}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="to">{t("To")}</label>
            <select className="input w-auto" id="to" name="to" defaultValue={to}>
              {versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {t(v.status)}</option>)}
            </select>
          </div>
          <button className="btn-secondary" type="submit">{t("Compare")}</button>
        </form>
      )}

      {diff && (
        <>
          <p className="text-ink-2">
            {diff.count === 0
              ? t("v{from} → v{to}: no differences.", { from: diff.from.version, to: diff.to.version })
              : diff.count === 1
                ? t("v{from} → v{to}: 1 difference.", { from: diff.from.version, to: diff.to.version })
                : t("v{from} → v{to}: {n} differences.", { from: diff.from.version, to: diff.to.version, n: diff.count })}
          </p>
          {diff.plan.length > 0 && <section className="card"><h2 className="h2">{t("Plan")}</h2><Changes changes={diff.plan} /></section>}
          <section className="grid gap-4 md:grid-cols-3">
            <div className="card">
              <h2 className="h2">{t("Added events")} <span className="text-sm font-normal text-ink-3">{diff.events.added.length}</span></h2>
              <ul className="mt-2 space-y-1 font-mono text-sm text-accent-ink">{diff.events.added.map((e) => <li key={e.event_name}>+ {e.event_name}</li>)}</ul>
            </div>
            <div className="card">
              <h2 className="h2">{t("Removed events")} <span className="text-sm font-normal text-ink-3">{diff.events.removed.length}</span></h2>
              <ul className="mt-2 space-y-1 font-mono text-sm text-alert">{diff.events.removed.map((e) => <li key={e.event_name}>− {e.event_name}</li>)}</ul>
            </div>
            <div className="card">
              <h2 className="h2">{t("Changed events")} <span className="text-sm font-normal text-ink-3">{diff.events.changed.length}</span></h2>
              <ul className="mt-2 space-y-3">
                {diff.events.changed.map((c) => (
                  <li key={c.event_name} className="space-y-1">
                    <span className="font-mono text-sm font-medium">{c.event_name}</span>
                    <Changes changes={c.changes} />
                    {c.properties.added.map((p) => <p key={`+${p.name}`} className="font-mono text-xs text-accent-ink">+ {p.name} ({p.type}{p.required ? `, ${t("required")}` : ""})</p>)}
                    {c.properties.removed.map((p) => <p key={`-${p.name}`} className="font-mono text-xs text-alert">− {p.name}</p>)}
                    {c.properties.changed.map((p) => <div key={`~${p.name}`}><span className="font-mono text-xs">~ {p.name}</span><Changes changes={p.changes} /></div>)}
                  </li>
                ))}
              </ul>
            </div>
          </section>
          <section className="card space-y-3">
            <h2 className="h2">{t("User properties")}</h2>
            {diff.user_properties.added.map((u) => <p key={`+${u.name}`} className="font-mono text-sm text-accent-ink">+ {u.name} ({u.type})</p>)}
            {diff.user_properties.removed.map((u) => <p key={`-${u.name}`} className="font-mono text-sm text-alert">− {u.name}</p>)}
            <NamedChanges title={t("Changed")} items={diff.user_properties.changed} />
            {diff.user_properties.added.length + diff.user_properties.removed.length + diff.user_properties.changed.length === 0 && <p className="text-sm text-ink-3">{t("No changes.")}</p>}
          </section>
          {diff.attribution_rules.added.length + diff.attribution_rules.removed.length + diff.attribution_rules.changed.length > 0 && (
            <section className="card space-y-2">
              <h2 className="h2">{t("Attribution")}</h2>
              {diff.attribution_rules.added.map((r) => <p key={`+${r.channel}`} className="text-sm text-accent-ink">+ {r.channel}</p>)}
              {diff.attribution_rules.removed.map((r) => <p key={`-${r.channel}`} className="text-sm text-alert">− {r.channel}</p>)}
              <NamedChanges title={t("Changed")} items={diff.attribution_rules.changed} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
