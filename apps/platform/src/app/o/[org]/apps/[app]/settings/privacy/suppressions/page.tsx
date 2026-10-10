import Link from "next/link";
import { addSuppressionAction, removeSuppressionAction } from "@/app/actions/privacy";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { CHANNELS, listSuppressions, suppressionCounts, userKeyOf } from "@/modules/privacy/consent";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Suppression list") };
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const fmt = (d: Date, lang: Lang) => new Date(d).toLocaleString(dateLocale(lang));
const CHANNEL_INFO: Record<(typeof CHANNELS)[number], string> = {
  marketing: msg("No marketing messages on any channel"),
  push: msg("No push notifications at all"),
  email: msg("No email at all"),
  whatsapp: msg("No WhatsApp messages at all"),
  sms: msg("No SMS at all"),
};
// "API" and "whatsapp" are names and stay as they are.
const SOURCE_LABEL: Record<string, string> = { manual: msg("Dashboard"), api: "API", consent: msg("Consent denied"), unsubscribe: msg("Unsubscribed") };
const CHANNEL_LABEL: Record<string, string> = { marketing: msg("marketing"), push: msg("push"), email: msg("email"), whatsapp: "whatsapp", sms: "SMS" };

export default async function SuppressionsPage(props: PageProps<"/o/[org]/apps/[app]/settings/privacy/suppressions">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = await pickEnvironment(environments, sp.env);
  const channel = (CHANNELS as readonly string[]).includes(one(sp.channel) ?? "") ? one(sp.channel) : undefined;
  const q = one(sp.q);
  const userKey = q ? (q.startsWith("anon:") ? q : userKeyOf({ userId: q })!) : undefined;
  const { rows, cursor } = await listSuppressions({ kind: "user", ctx }, env.id, { channel, userKey, limit: 100, before: one(sp.before) });
  const counts = await suppressionCounts(ctx, env.id);
  const base = `/o/${org}/apps/${app}/settings/privacy/suppressions`;
  const api = publicBaseUrl();
  // One sentence with the link in its place, so it reads naturally in both languages.
  const intro = t("Users who must not be messaged, per channel. Automations check this list before every send. Users who deny marketing or push {link} are added automatically and removed when they grant it again.").split("{link}");
  const filterHref = (c?: string) => `${base}?${new URLSearchParams({ env: env.type, ...(c ? { channel: c } : {}), ...(q ? { q } : {}) })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Suppression list")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {intro[0]}
            <Link className="underline" href={`/o/${org}/apps/${app}/settings/privacy/consent?env=${env.type}`}>{t("consent")}</Link>
            {intro[1]}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {CHANNELS.map((c) => (
          <Link key={c} href={filterHref(channel === c ? undefined : c)} className={`card block ${channel === c ? "ring-2 ring-ink" : ""}`}>
            <p className="eyebrow">{t(CHANNEL_LABEL[c])}</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{counts[c].toLocaleString("en-US")}</p>
            <p className="text-xs text-ink-3">{t(CHANNEL_INFO[c])}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="card space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="h2">{channel ? t("Suppressed for {channel}", { channel: t(CHANNEL_LABEL[channel]) }) : t("Suppressed")}</h2>
            <form method="get" className="flex items-end gap-2">
              <input type="hidden" name="env" value={env.type} />
              {channel && <input type="hidden" name="channel" value={channel} />}
              <input name="q" className="input w-56" placeholder={t("User ID or anon:<id>")} defaultValue={q ?? ""} maxLength={262} />
              <button className="btn-secondary" type="submit">{t("Find")}</button>
            </form>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-ink-3">{q || channel ? t("No matching entries.") : t("Nobody is suppressed in this environment.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>{t("User")}</th><th>{t("Channel")}</th><th>{t("Source")}</th><th>{t("Reason")}</th><th>{t("Added")}</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td dir="ltr" className="max-w-[220px] break-all font-mono text-xs">{r.user_key}</td>
                      <td>{t(CHANNEL_LABEL[r.channel])}</td>
                      <td>{t(SOURCE_LABEL[r.source])}{r.created_by_name ? <span className="text-ink-3"> · {r.created_by_name}</span> : null}</td>
                      <td className="text-ink-2">{r.reason ?? ""}</td>
                      <td className="whitespace-nowrap text-ink-3">{fmt(r.created_at, lang)}</td>
                      <td className="text-end">
                        {r.source === "consent" ? (
                          <span className="text-xs text-ink-3" title={t("Removed automatically when the user grants consent again")}>{t("Follows consent")}</span>
                        ) : (
                          <ActionForm
                            action={removeSuppressionAction.bind(null, org, app, env.id, r.user_key, r.channel)}
                            submitLabel={t("Remove")}
                            buttonClass="btn-secondary"
                            className="inline"
                            confirm={t("Allow {channel} messages to {user} again?", { channel: t(CHANNEL_LABEL[r.channel]), user: r.user_key })}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <Link className="text-sm underline" href={`${filterHref(channel)}&before=${encodeURIComponent(cursor)}`}>{t("Older entries")}</Link>
          )}
        </section>

        <section className="card space-y-3 lg:self-start">
          <h2 className="h2">{t("Add")}</h2>
          <ActionForm action={addSuppressionAction.bind(null, org, app, env.id)} submitLabel={t("Suppress")} className="space-y-3">
            <label className="block"><span className="label">{t("User ID")}</span><input name="userId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">{t("or anonymous ID")}</span><input name="anonymousId" className="input" maxLength={256} /></label>
            <fieldset className="space-y-1">
              <legend className="label">{t("Channels")}</legend>
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="channel" value={c} defaultChecked={c === "marketing"} /> {t(CHANNEL_LABEL[c])}
                  <span className="text-xs text-ink-3">{t(CHANNEL_INFO[c])}</span>
                </label>
              ))}
            </fieldset>
            <label className="block"><span className="label">{t("Reason (optional)")}</span><input name="reason" className="input" maxLength={500} placeholder={t("e.g. asked support to stop messages")} /></label>
          </ActionForm>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">{t("From your backend")}</h2>
        <p className="text-sm text-ink-3">{t('Secret API key of this environment: "manage suppressions" (privacy:write) to add and remove, privacy:read to list.')}</p>
        <CodeTabs
          preferred="add"
          tabs={[
            {
              key: "add",
              label: t("Add"),
              code: `curl -X POST ${api}/v1/privacy/suppressions \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123","channels":["marketing","email"],"reason":"unsubscribed"}'`,
            },
            {
              key: "remove",
              label: t("Remove"),
              code: `curl -X DELETE "${api}/v1/privacy/suppressions?user_id=user_123&channel=email" \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
            {
              key: "list",
              label: t("List"),
              code: `curl "${api}/v1/privacy/suppressions?channel=marketing&limit=100" \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
          ]}
        />
      </section>
    </div>
  );
}
