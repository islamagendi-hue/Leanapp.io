import Link from "next/link";
import { describePropertyAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { param } from "@/components/AnalyticsHeader";
import { propertyCatalog, type CatalogProperty, type PropertyScope } from "@/modules/properties/catalog";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Attributes" };

const when = (d: Date | null, tz: string) => (d ? new Date(d).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: tz }) : null);

export default async function AttributesPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/attributes">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "implementation.read");
  const env = await pickEnvironment(environments, sp.env);
  const tab: PropertyScope = param(sp.tab) === "event" ? "event" : "user";
  const catalog = await propertyCatalog(ctx, { appId: a.id, environmentId: env.id }, "implementation.read");
  const list = catalog[tab];
  const canEdit = can(ctx.role, "implementation.edit");
  const base = `/o/${org}/apps/${app}`;
  const path = `${base}/settings/dev-ops/attributes`;
  const tabLink = (t: PropertyScope) => `${path}?${new URLSearchParams({ env: env.type, tab: t })}`;
  const save = describePropertyAction.bind(null, org, app, a.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Attributes</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          Every user and event property this project has: what your app sends in <strong>{env.type}</strong>, joined with the tracking plan.
          Users, Audiences and Analytics pick properties from this same list.
        </p>
      </div>

      <nav className="flex gap-2" aria-label="Property kind">
        {(["user", "event"] as const).map((t) => (
          <Link key={t} href={tabLink(t)} aria-current={t === tab ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${t === tab ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2"}`}>
            {t === "user" ? "User properties" : "Event properties"} <span className="text-ink-3">· {catalog[t].length}</span>
          </Link>
        ))}
      </nav>

      <p className="text-xs text-ink-3">
        {tab === "user"
          ? `Seen counts come from the ${catalog.sample.users.toLocaleString("en-US")} most recently seen users.`
          : `Seen counts come from the ${catalog.sample.events.toLocaleString("en-US")} most recent events of the last ${catalog.sample.eventDays} days.`}{" "}
        {catalog.planVersion ? <>Plan columns use tracking plan v{catalog.planVersion}.</> : <>There is no tracking plan yet. <Link className="underline" href={`${base}/settings/dev-ops/implementation/plan`}>Create one</Link> to add types and descriptions.</>}
      </p>

      {list.length === 0 ? (
        <div className="card">
          <p>No {tab} properties in {env.type} yet.</p>
          <p className="mt-1 text-sm text-ink-3">
            {tab === "user" ? "User properties appear once your app sends traits with identify() or setUserProperties()." : "Event properties appear once your app sends events with properties."}
          </p>
        </div>
      ) : (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th className="text-start">Property</th>
                <th className="text-start">Type</th>
                <th className="text-start">Description</th>
                <th className="text-start">Seen</th>
                <th className="text-start">Values</th>
                <th className="text-start">Source</th>
                <th className="text-start">Tracking plan</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => <Row key={p.name} p={p} tz={a.timezone} canEdit={canEdit} save={save} />)}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Row({ p, tz, canEdit, save }: { p: CatalogProperty; tz: string; canEdit: boolean; save: Parameters<typeof ActionForm>[0]["action"] }) {
  const last = when(p.lastSeen, tz);
  return (
    <tr className="align-top">
      <td className="font-mono text-sm">
        {p.name}
        {p.builtIn && <span className="ms-1 rounded bg-paper-2 px-1 text-[10px] uppercase text-ink-3">built in</span>}
      </td>
      <td className="text-sm">
        {p.type}
        {p.typeMismatch && <p className="text-xs text-warn" title={`Data: ${p.observedTypes.join(", ")}`}>Data sends {p.observedTypes[0]}</p>}
        {!p.typeMismatch && p.observedTypes.length > 1 && <p className="text-xs text-warn">Mixed: {p.observedTypes.join(", ")}</p>}
      </td>
      <td className="min-w-56 text-sm">
        {p.description ? <span className={p.descriptionFrom === "custom" ? "" : "text-ink-2"}>{p.description}</span> : <span className="text-ink-3">–</span>}
        {canEdit && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-accent-ink">{p.customDescription ? "Edit description" : "Describe"}</summary>
            <ActionForm action={save} submitLabel="Save" className="mt-2 space-y-2" buttonClass="btn-secondary min-h-8 text-xs">
              <input type="hidden" name="scope" value={p.scope} />
              <input type="hidden" name="name" value={p.name} />
              <textarea name="description" className="input text-sm" rows={2} maxLength={500} defaultValue={p.customDescription} aria-label={`Description of ${p.name}`}
                placeholder={p.descriptionFrom === "plan" || p.descriptionFrom === "built_in" ? p.description : "What this property means"} />
            </ActionForm>
          </details>
        )}
      </td>
      <td className="whitespace-nowrap text-sm">
        {p.seen ? <>{p.seen.toLocaleString("en-US")}{last && <p className="text-xs text-ink-3">last {last}</p>}</> : <span className="text-ink-3">Not seen yet</span>}
        {p.events.length > 0 && <p className="max-w-48 truncate text-xs text-ink-3" title={p.events.join(", ")}>on {p.events.join(", ")}</p>}
      </td>
      <td className="max-w-64 text-xs">
        {p.values.length === 0 ? <span className="text-ink-3">–</span> : (
          <ul className="flex flex-wrap gap-1">
            {p.values.slice(0, 6).map((v) => (
              <li key={v.value} className="max-w-40 truncate rounded bg-paper-2 px-1.5 py-0.5 font-mono" title={v.count === null ? "Allowed by the plan" : `${v.count} times`}>{v.value}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="min-w-40 text-xs">
        <p>{p.source}</p>
        <p className="font-mono text-ink-3">{p.sdk}</p>
      </td>
      <td className="text-xs">
        {p.builtIn ? <span className="text-ink-3">Always sent</span> : p.plan ? (
          <>
            <p>In plan{p.plan.required ? " · required" : ""}</p>
            {p.plan.events.length > 0 && <p className="max-w-48 truncate text-ink-3" title={p.plan.events.join(", ")}>{p.plan.events.join(", ")}</p>}
          </>
        ) : <span className="text-warn">Not in plan</span>}
      </td>
    </tr>
  );
}
