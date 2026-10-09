import Link from "next/link";
import { AutoApply } from "@/components/AutoApply";
import { AnalyticsHeader, param } from "@/components/AnalyticsHeader";
import { CohortSelect } from "@/components/CohortSelect";
import { PropertyFilters } from "@/components/PropertyFilters";
import { getLang, getT } from "@/i18n/server";
import { dateLocale } from "@/i18n/translate";
import { MAX_USER_COLUMNS, MAX_USER_FILTERS, searchPeople } from "@/modules/analytics/profiles";
import { catalogForPickers, options } from "@/modules/properties/catalog";
import { filtersFromSearch } from "@/modules/properties/filters";
import { cohortFilter } from "@/server/analytics-page";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Users") };
}

export default async function UsersPage(props: PageProps<"/o/[org]/apps/[app]/analytics/users">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const when = (d: Date) => new Date(d).toLocaleString(dateLocale(lang), { dateStyle: "medium", timeStyle: "short", timeZone: a.timezone });
  requirePermission(ctx, "users.read");
  const env = await pickEnvironment(environments, sp.env);
  const q = param(sp.q)?.trim() ?? "";
  const catalog = await catalogForPickers(ctx, { appId: a.id, environmentId: env.id }, "users.read", { only: "user" });
  const userProps = options(catalog.user);
  const { filters, parts } = filtersFromSearch(sp, "f", MAX_USER_FILTERS);
  const cols = (Array.isArray(sp.col) ? sp.col : sp.col ? [sp.col] : []).slice(0, MAX_USER_COLUMNS);
  const audience = await cohortFilter(ctx, env.id, sp.cohort);
  const res = await searchPeople(ctx, env.id, q, { limit: 50, filters, columns: cols, audienceId: audience.cohortId, timezone: a.timezone });
  const filtering = filters.length > 0 || Boolean(audience.cohortId);
  const show = (v: unknown) => (v === undefined || v === null ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const path = `/o/${org}/apps/${app}/analytics/users`;
  const profile = (k: "user" | "anon", id: string) => `${path}/profile?${new URLSearchParams({ env: env.type, [k]: id })}`;

  return (
    <div className="space-y-6">
      <AnalyticsHeader title={t("Users")} description={t("Find one of your app's users by their user ID or an install's anonymous ID, and see everything they did.")} env={env.type} />

      <form method="get" className="card space-y-4">
        <input type="hidden" name="env" value={env.type} />
        <AutoApply />
        <label className="block max-w-xl"><span className="label">{t("User ID or anonymous ID")}</span>
          <input name="q" className="input font-mono" defaultValue={q} maxLength={256} placeholder={t("Starts with…")} autoComplete="off" />
        </label>
        <div className="max-w-xs"><CohortSelect cohorts={audience.cohorts} value={audience.cohortId} /></div>
        <PropertyFilters options={userProps} initial={parts} max={MAX_USER_FILTERS} label={t("User properties")} />
        {userProps.length > 0 && (
          <details className="text-sm" open={cols.length > 0}>
            <summary className="cursor-pointer text-ink-2">{t("Columns ({n}/{max})", { n: cols.length, max: MAX_USER_COLUMNS })}</summary>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {userProps.slice(0, 40).map((o) => (
                <label key={o.name} className="inline-flex items-center gap-1 font-mono text-xs"><input type="checkbox" name="col" value={o.name} defaultChecked={cols.includes(o.name)} />{o.name}</label>
              ))}
            </div>
          </details>
        )}
        <button className="btn" type="submit">{t("Search")}</button>
      </form>

      {audience.missing && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{t("That audience is archived or no longer exists in this environment, so the list isn't limited to it.")}</p>}

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-5 pt-4">{q || filtering ? t("Users") : t("Recently seen users")}</h2>
        {res.users.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">
            {filtering ? t("No user matches these filters.") : q ? t("No user ID starts with that.") : t("No identified users in this environment yet. Users appear once your app calls identify().")}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="text-start">{t("User ID")}</th>
                {cols.map((c) => <th key={c} className="text-start font-mono text-xs">{c}</th>)}
                <th className="text-start">{t("First seen")}</th><th className="text-start">{t("Last seen")}</th>
              </tr>
            </thead>
            <tbody>
              {res.users.map((u) => (
                <tr key={u.userId}>
                  <td className="font-mono text-sm"><Link className="underline" href={profile("user", u.userId)}>{u.userId}</Link></td>
                  {cols.map((c) => <td key={c} className="max-w-48 truncate text-sm">{show(u.properties[c])}</td>)}
                  <td className="whitespace-nowrap">{when(u.firstSeen)}</td>
                  <td className="whitespace-nowrap">{when(u.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {q && !filtering && (
        <section className="card overflow-x-auto p-0">
          <h2 className="h2 px-5 pt-4">{t("Installs")}</h2>
          {res.installs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">{t("No anonymous ID starts with that.")}</p>
          ) : (
            <table className="table">
              <thead><tr><th className="text-start">{t("Anonymous ID")}</th><th className="text-start">{t("Platform")}</th><th className="text-start">{t("Linked users")}</th><th className="text-start">{t("Last seen")}</th></tr></thead>
              <tbody>
                {res.installs.map((i) => (
                  <tr key={i.anonymousId}>
                    <td className="font-mono text-sm">
                      <Link className="underline" href={i.linkedUsers.length === 1 ? profile("user", i.linkedUsers[0]) : profile("anon", i.anonymousId)}>{i.anonymousId}</Link>
                    </td>
                    <td>{i.platform ?? "–"}</td>
                    <td className="text-sm">
                      {i.linkedUsers.length === 0 ? <span className="text-ink-3">{t("Anonymous")}</span>
                        : i.linkedUsers.length === 1 ? <span className="font-mono">{i.linkedUsers[0]}</span>
                        : <span title={t("Linked to several users, so its anonymous activity isn't merged into any of them")}>{t("Shared device · {n} users", { n: i.linkedUsers.length })}</span>}
                    </td>
                    <td className="whitespace-nowrap">{when(i.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      <p className="text-xs text-ink-3">
        {t("Search matches the start of an ID, exact matches first. Audience and property filters apply to identified users. Property filters use the same properties as Audiences and Analytics (Settings → Dev Ops → Attributes). Up to 50 users are listed. Times are in the app's timezone ({timezone}).", { timezone: a.timezone })}
      </p>
    </div>
  );
}
