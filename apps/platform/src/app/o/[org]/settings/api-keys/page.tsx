import Link from "next/link";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, type Lang, type T } from "@/i18n/translate";
import { listKeys } from "@/modules/credentials/service";
import { getAppBySlug, listApps } from "@/modules/apps/service";
import { can } from "@/modules/rbac/authorize";
import { requirePermission, requireTenant } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("API keys") };
}

const ORDER = { production: 0, staging: 1, development: 2 } as const;
const when = (d: Date | null, t: T, lang: Lang) => (d ? new Date(d).toLocaleDateString(dateLocale(lang), { day: "numeric", month: "short", year: "numeric" }) : t("Never"));
const live = (k: { status: string; expires_at: Date | null }) => k.status === "active" && (!k.expires_at || new Date(k.expires_at) > new Date());

/**
 * Every project's keys in one place, per environment (production, staging,
 * development). Keys are created, rotated and revoked on each project's SDK &
 * API keys page, which this links to.
 */
export default async function ApiKeysPage(props: PageProps<"/o/[org]/settings/api-keys">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "credentials.read");
  const apps = await listApps(ctx);
  const projects = await Promise.all(
    apps.map(async (a) => {
      const [{ environments }, keys] = await Promise.all([getAppBySlug(ctx, a.slug), listKeys(ctx, a.id)]);
      const rows = [...environments]
        .sort((x, y) => ORDER[x.type] - ORDER[y.type])
        .map((e) => {
          const sdk = keys.sdkKeys.filter((k) => k.environment_id === e.id && live(k));
          const api = keys.apiKeys.filter((k) => k.environment_id === e.id && live(k));
          const used = [...sdk, ...api].map((k) => k.last_used_at).filter((d): d is Date => !!d).sort((x, y) => +new Date(y) - +new Date(x))[0] ?? null;
          return { env: e, sdk: sdk[0]?.key ?? null, sdkCount: sdk.length, apiCount: api.length, used };
        });
      return { app: a, rows };
    }),
  );
  const manage = can(ctx.role, "credentials.manage");
  const t = await getT();
  const lang = await getLang();
  // The sentence is translated whole; {link} marks where the link goes.
  const noProjects = t("No projects yet. {link} to get its keys.").split("{link}");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("API keys")}</h1>
        <p className="mt-1 max-w-2xl text-ink-2">
          {t("Each project has three environments, each with its own keys and its own data. The public SDK key goes in your app; secret API keys are for your servers only.")}
          {" "}{manage ? t("Create, rotate or revoke keys from Manage.") : t("Ask an owner or admin to create or revoke keys.")}
        </p>
      </div>
      {projects.length === 0 && <p className="card text-sm text-ink-2">{noProjects[0]}<Link className="underline" href={`/o/${org}`}>{t("Create one")}</Link>{noProjects[1]}</p>}
      {projects.map(({ app, rows }) => (
        <section key={app.id} className="card overflow-x-auto p-0" aria-label={app.name}>
          <h2 className="h2 px-5 pt-5">{app.name}</h2>
          <table className="table mt-3">
            <thead><tr><th>{t("Environment")}</th><th>{t("Public SDK key")}</th><th className="min-w-40 text-end">{t("Secret API keys")}</th><th className="min-w-28">{t("Last used")}</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.env.id}>
                  <td>
                    <span className="font-medium">{t(r.env.name)}</span>
                    {r.env.status === "disabled" && <span className="pill ms-2 border-warn/40 text-warn">{t("Paused")}</span>}
                  </td>
                  <td className="font-mono text-xs" dir="ltr">{r.sdk ? <>{r.sdk.slice(0, 14)}…{r.sdkCount > 1 && <span className="ms-1 text-ink-3">{t("+{n} rotating", { n: r.sdkCount - 1 })}</span>}</> : <span className="text-ink-3">{t("None active")}</span>}</td>
                  <td className="text-end tabular-nums">{r.apiCount}</td>
                  <td className="text-sm text-ink-3">{when(r.used, t, lang)}</td>
                  <td className="text-end"><Link className="text-sm underline" href={`/o/${org}/apps/${app.slug}/settings/dev-ops/sdk?env=${r.env.type}`}>{manage ? t("Manage") : t("View")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
