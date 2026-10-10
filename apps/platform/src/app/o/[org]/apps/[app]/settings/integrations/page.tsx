import Link from "next/link";
import { envName } from "@/components/acquisition/rich";
import { CapabilityStatusPill } from "@/components/integrations/CapabilityStatus";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, type Lang } from "@/i18n/translate";
import { paymentsConnected } from "@/modules/billing/stripe";
import { capabilityState } from "@/modules/integrations/center";
import { CATEGORIES, PROVIDERS, providerRoles, type ProviderDescriptor } from "@/modules/integrations/registry";
import { centerData } from "@/modules/integrations/service";
import { freshness } from "@/modules/integrations/status";
import { localDate } from "@/modules/analytics/range";
import { can } from "@/modules/rbac/authorize";
import { SUPPORT_EMAIL } from "@/modules/support/contact";
import { loadApp, pickEnvironment } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Integrations") };
}

const when = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : null);

export default async function IntegrationsPage(props: PageProps<"/o/[org]/apps/[app]/settings/integrations">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  const env = await pickEnvironment(environments, sp.env);
  const data = await centerData(ctx, a.id, env.id);
  const input = { ...data, paymentsConnected: can(ctx.role, "billing.read") ? paymentsConnected() : null };
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const base = `/o/${org}/apps/${app}`;
  const today = localDate(new Date(), a.timezone);

  const card = (p: ProviderDescriptor) => {
    const roles = providerRoles(p);
    return (
      <li key={p.id} aria-label={t(p.name)} className="card flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{t(p.name)}</span>
          <span className="flex flex-wrap gap-1">
            {roles.includes("data_source") && <span className="pill border-line text-ink-2">{t("Data source")}</span>}
            {roles.includes("service_provider") && <span className="pill border-line text-ink-2">{t("Service provider")}</span>}
            {p.implementation === "descriptor" && <span className="pill border-line text-ink-3">{t("Not built")}</span>}
          </span>
        </div>
        {p.note && <p className="text-sm text-ink-2">{t(p.note)}</p>}
        {p.capabilities.length > 0 && (
          <ul className="space-y-3">
            {p.capabilities.map((c) => {
              const s = capabilityState(p, c, input);
              const fresh = c.direction === "inbound" && s.freshThrough ? freshness(s.freshThrough, today) : null;
              const open = c.setupPath && (!c.perm || can(ctx.role, c.perm));
              const href = c.orgLevel ? `/o/${org}/${c.setupPath}` : `${base}/${c.setupPath}`;
              return (
                <li key={c.id} className="rounded-lg border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{t(c.title)} <span className="text-xs text-ink-3">· {c.direction === "inbound" ? t("Inbound") : t("Outbound")}</span></span>
                    <CapabilityStatusPill t={t} status={s.status} />
                  </div>
                  <p className="mt-1 text-ink-2">{t(c.description)}</p>
                  {s.detail && <p className="mt-1 text-xs text-ink-3">{t(s.detail)}</p>}
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-ink-2">
                    {s.lastSuccessAt && (<><dt className="text-ink-3">{t("Last success")}</dt><dd>{when(s.lastSuccessAt, lang)}</dd></>)}
                    {fresh && (<><dt className="text-ink-3">{t("Data through")}</dt><dd className={fresh.state === "stale" ? "text-warn" : ""}>{s.freshThrough}{fresh.state === "stale" ? ` · ${t("{n} days behind", { n: fresh.lagDays ?? 0 })}` : ""}</dd></>)}
                    {c.requirements.length > 0 && (<><dt className="text-ink-3">{t("Needs")}</dt><dd>{c.requirements.map((r) => t(r)).join(" · ")}</dd></>)}
                    {c.providerPermissions.length > 0 && (<><dt className="text-ink-3">{t("Provider permissions")}</dt><dd className="font-mono break-all" dir="ltr">{c.providerPermissions.map((r) => t(r)).join(", ")}</dd></>)}
                  </dl>
                  {s.errors.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-alert" aria-label={t("Recent errors")}>
                      {s.errors.map((e, i) => (
                        <li key={i} className="break-words">{e.at ? `${when(e.at, lang)} · ` : ""}{e.code ? `[${e.code}] ` : ""}{e.message}</li>
                      ))}
                    </ul>
                  )}
                  {open && (
                    <Link href={href} className="mt-2 inline-block font-medium text-accent-ink underline">
                      {s.status === "not_configured" ? t("Set up") : t("Manage")}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-auto flex flex-wrap gap-3 pt-1 text-sm">
          {p.docsUrl && <a href={p.docsUrl} target="_blank" rel="noreferrer" className="text-ink-2 underline">{t("Official API docs")}</a>}
          {p.implementation === "descriptor" && (
            <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Integration request: ${p.name}`)}`} className="text-ink-2 underline">{t("Ask for it")}</a>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="h1">{t("Integrations")}</h1>
        <p className="mt-1 max-w-3xl text-ink-2">
          {t("Every provider this project can connect to, in {env}. Each capability has its own status: connecting a network's conversions API doesn't import its costs, and the other way round. \"Verified\" means a real call to the provider succeeded.", { env: envName(t, env.type) })}
        </p>
      </div>
      {CATEGORIES.map((cat) => {
        const providers = PROVIDERS.filter((p) => p.category === cat.id);
        return (
          <section key={cat.id} aria-labelledby={`int-${cat.id}`}>
            <h2 id={`int-${cat.id}`} className="font-bold">{t(cat.title)}</h2>
            <p className="mb-3 text-sm text-ink-3">{t(cat.blurb)}</p>
            {providers.length === 0 ? (
              <p className="text-sm text-ink-3">{t("Nothing in this category is built yet.")}</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{providers.map(card)}</ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
