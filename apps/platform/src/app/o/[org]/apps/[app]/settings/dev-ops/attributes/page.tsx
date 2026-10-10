import Link from "next/link";
import { describePropertyAction } from "@/app/actions/implementation";
import { ActionForm } from "@/components/ActionForm";
import { param } from "@/components/AnalyticsHeader";
import { propertyCatalog, type CatalogProperty, type PropertyScope } from "@/modules/properties/catalog";
import { localizeText } from "@/modules/implementation/localize";
import { can } from "@/modules/rbac/authorize";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber, type Lang, type T } from "@/i18n/translate";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Attributes") };
}

const when = (d: Date | null, tz: string, lang: Lang) => (d ? new Date(d).toLocaleDateString(dateLocale(lang), { dateStyle: "medium", timeZone: tz }) : null);

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
  const tabLink = (k: PropertyScope) => `${path}?${new URLSearchParams({ env: env.type, tab: k })}`;
  const save = describePropertyAction.bind(null, org, app, a.id);
  const t = await getT();
  const lang = await getLang();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Attributes")}</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          {(([x, y]) => <>{x}<strong>{t(env.type)}</strong>{y}</>)(t("Every user and event property this project has: what your app sends in {env}, joined with the tracking plan.").split("{env}"))}
          {" "}{t("Users, Audiences and Analytics pick properties from this same list.")}
        </p>
      </div>

      <nav className="flex gap-2" aria-label={t("Property kind")}>
        {(["user", "event"] as const).map((k) => (
          <Link key={k} href={tabLink(k)} aria-current={k === tab ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${k === tab ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2"}`}>
            {k === "user" ? t("User properties") : t("Event properties")} <span className="text-ink-3">· {catalog[k].length}</span>
          </Link>
        ))}
      </nav>

      <p className="text-xs text-ink-3">
        {tab === "user"
          ? t("Seen counts come from the {n} most recently seen users.", { n: fmtNumber(catalog.sample.users) })
          : t("Seen counts come from the {n} most recent events of the last {days} days.", { n: fmtNumber(catalog.sample.events), days: catalog.sample.eventDays })}{" "}
        {catalog.planVersion ? <>{t("Plan columns use tracking plan v{n}.", { n: catalog.planVersion })}</> : (([x, y]) => <>{x}<Link className="underline" href={`${base}/settings/dev-ops/implementation/plan`}>{t("Create one")}</Link>{y}</>)(t("There is no tracking plan yet. {link} to add types and descriptions.").split("{link}"))}
      </p>

      {list.length === 0 ? (
        <div className="card">
          <p>{tab === "user" ? t("No user properties in {env} yet.", { env: t(env.type) }) : t("No event properties in {env} yet.", { env: t(env.type) })}</p>
          <p className="mt-1 text-sm text-ink-3">
            {tab === "user" ? t("User properties appear once your app sends traits with identify() or setUserProperties().") : t("Event properties appear once your app sends events with properties.")}
          </p>
        </div>
      ) : (
        <section className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th className="text-start">{t("Property")}</th>
                <th className="text-start">{t("Type")}</th>
                <th className="text-start">{t("Description")}</th>
                <th className="text-start">{t("Seen")}</th>
                <th className="text-start">{t("Values")}</th>
                <th className="text-start">{t("Source")}</th>
                <th className="text-start">{t("Tracking plan")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => <Row key={p.name} p={p} tz={a.timezone} canEdit={canEdit} save={save} t={t} lang={lang} />)}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Row({ p, tz, canEdit, save, t, lang }: { p: CatalogProperty; tz: string; canEdit: boolean; save: Parameters<typeof ActionForm>[0]["action"]; t: T; lang: Lang }) {
  const last = when(p.lastSeen, tz, lang);
  // Plan and built-in descriptions come from the catalog; a custom one is the customer's own text.
  const description = p.descriptionFrom === "custom" ? p.description : localizeText(p.description, t, lang);
  return (
    <tr className="align-top">
      <td className="font-mono text-sm">
        {p.name}
        {p.builtIn && <span className="ms-1 rounded bg-paper-2 px-1 text-[10px] uppercase text-ink-3">{t("built in")}</span>}
      </td>
      <td className="text-sm">
        {p.type}
        {p.typeMismatch && <p className="text-xs text-warn" title={t("Data: {types}", { types: p.observedTypes.join(", ") })}>{t("Data sends {type}", { type: p.observedTypes[0] })}</p>}
        {!p.typeMismatch && p.observedTypes.length > 1 && <p className="text-xs text-warn">{t("Mixed: {types}", { types: p.observedTypes.join(", ") })}</p>}
      </td>
      <td className="min-w-56 text-sm">
        {p.description ? <span className={p.descriptionFrom === "custom" ? "" : "text-ink-2"}>{description}</span> : <span className="text-ink-3">–</span>}
        {canEdit && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-accent-ink">{p.customDescription ? t("Edit description") : t("Describe")}</summary>
            <ActionForm action={save} submitLabel={t("Save")} className="mt-2 space-y-2" buttonClass="btn-secondary min-h-8 text-xs">
              <input type="hidden" name="scope" value={p.scope} />
              <input type="hidden" name="name" value={p.name} />
              <textarea name="description" className="input text-sm" rows={2} maxLength={500} defaultValue={p.customDescription} aria-label={t("Description of {name}", { name: p.name })}
                placeholder={p.descriptionFrom === "plan" || p.descriptionFrom === "built_in" ? description : t("What this property means")} />
            </ActionForm>
          </details>
        )}
      </td>
      <td className="whitespace-nowrap text-sm">
        {p.seen ? <>{p.seen.toLocaleString("en-US")}{last && <p className="text-xs text-ink-3">{t("last {date}", { date: last })}</p>}</> : <span className="text-ink-3">{t("Not seen yet")}</span>}
        {p.events.length > 0 && <p className="max-w-48 truncate text-xs text-ink-3" title={p.events.join(", ")}>{t("on {events}", { events: p.events.join(", ") })}</p>}
      </td>
      <td className="max-w-64 text-xs">
        {p.values.length === 0 ? <span className="text-ink-3">–</span> : (
          <ul className="flex flex-wrap gap-1">
            {p.values.slice(0, 6).map((v) => (
              <li key={v.value} className="max-w-40 truncate rounded bg-paper-2 px-1.5 py-0.5 font-mono" title={v.count === null ? t("Allowed by the plan") : t("{n} times", { n: v.count })}>{v.value}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="min-w-40 text-xs">
        <p>{t(p.source)}</p>
        <p className="font-mono text-ink-3">{t(p.sdk)}</p>
      </td>
      <td className="text-xs">
        {p.builtIn ? <span className="text-ink-3">{t("Always sent")}</span> : p.plan ? (
          <>
            <p>{p.plan.required ? t("In plan · required") : t("In plan")}</p>
            {p.plan.events.length > 0 && <p className="max-w-48 truncate text-ink-3" title={p.plan.events.join(", ")}>{p.plan.events.join(", ")}</p>}
          </>
        ) : <span className="text-warn">{t("Not in plan")}</span>}
      </td>
    </tr>
  );
}
