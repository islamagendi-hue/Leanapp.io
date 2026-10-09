import { requestDeletionAction } from "@/app/actions/privacy";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { listPrivacyRequests } from "@/modules/privacy/service";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export async function generateMetadata() {
  const t = await getT();
  return { title: t("Privacy requests") };
}

const fmt = (d: Date | null, lang: Lang) => (d ? new Date(d).toLocaleString(dateLocale(lang)) : "–");
const ENV_LABEL: Record<string, string> = { development: msg("Development"), staging: msg("Staging"), production: msg("Production") };
const KIND_LABEL: Record<string, string> = { export: msg("export"), deletion: msg("deletion") };
const STATUS_LABEL: Record<string, string> = { received: msg("received"), processing: msg("processing"), completed: msg("completed"), rejected: msg("rejected") };

export default async function PrivacyPage(props: PageProps<"/o/[org]/apps/[app]/settings/privacy">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = await pickEnvironment(environments, sp.env);
  const requests = await listPrivacyRequests(ctx, env.id);
  const api = publicBaseUrl();
  const base = `/o/${org}/apps/${app}/settings/privacy`;
  const [t, lang] = await Promise.all([getT(), getLang()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">{t("Privacy requests")}</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            {t("Export or delete everything stored about one of your app's users in this environment. Use the user's ID, an install's anonymous ID, or both.")}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="h2">{t("Export a user's data")}</h2>
          <p className="text-sm text-ink-3">{t("Downloads a JSON file with their events, sessions, profile, installs, push tokens and consent.")}</p>
          <form action={`${base}/export`} method="post" className="space-y-3">
            <input type="hidden" name="environment" value={env.id} />
            <label className="block"><span className="label">{t("User ID")}</span><input name="user_id" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">{t("Anonymous ID")}</span><input name="anonymous_id" className="input" maxLength={256} /></label>
            <button className="btn-secondary" type="submit">{t("Download export")}</button>
          </form>
        </section>

        <section className="card space-y-3">
          <h2 className="h2">{t("Delete a user's data")}</h2>
          <p className="text-sm text-ink-3">
            {t("Permanent. Removes their events, sessions, profile and push tokens in the {env} environment. Anonymous activity on a device shared with another user is kept, because it can't be attributed. Stop sending events for them first, or new data will arrive.", { env: t(ENV_LABEL[env.type] ?? env.type) })}
          </p>
          <ActionForm action={requestDeletionAction.bind(null, org, app, env.id)} submitLabel={t("Delete data")} buttonClass="btn-danger" className="space-y-3">
            <label className="block"><span className="label">{t("User ID")}</span><input name="userId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">{t("Anonymous ID")}</span><input name="anonymousId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">{t('Type "delete" to confirm')}</span><input name="confirm" className="input" autoComplete="off" required /></label>
          </ActionForm>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">{t("From your backend")}</h2>
        <p className="text-sm text-ink-3">{t('Use a secret API key of this environment with the "Export user data" or "Delete user data" permission (SDK & keys). Deletions run in the background; poll the returned ID for the result.')}</p>
        <CodeTabs
          preferred="delete"
          tabs={[
            {
              key: "delete",
              label: t("Delete"),
              code: `curl -X POST ${api}/v1/privacy/deletions \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123"}'

# → 202 {"id":"…","status":"received"}
curl ${api}/v1/privacy/deletions/<id> -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
            {
              key: "export",
              label: t("Export"),
              code: `curl -X POST ${api}/v1/privacy/exports \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123"}'`,
            },
          ]}
        />
      </section>

      <section className="card space-y-3">
        <h2 className="h2">{t("History")}</h2>
        {requests.length === 0 ? (
          <p className="text-sm text-ink-3">{t("No requests in this environment yet.")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("Requested")}</th><th>{t("Type")}</th><th>{t("Person")}</th><th>{t("By")}</th><th>{t("Status")}</th><th>{t("Rows deleted")}</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="text-ink-3">{fmt(r.created_at, lang)}</td>
                    <td>{t(KIND_LABEL[r.kind] ?? r.kind)}</td>
                    <td dir="ltr" className="font-mono text-xs break-all">
                      {r.subject_user_id && <div>user: {r.subject_user_id}</div>}
                      {r.subject_anonymous_id && <div>anon: {r.subject_anonymous_id}</div>}
                    </td>
                    <td>{r.requested_by_name ?? t("API key")}</td>
                    <td>
                      {r.job_status === "failed" ? <span className="text-alert" title={r.error ?? ""}>{t("failed")}</span> : t(STATUS_LABEL[r.status] ?? r.status)}
                      {r.job_status === "queued" && r.error && <div className="text-xs text-ink-3">{t("retrying")}</div>}
                    </td>
                    <td>{r.kind === "deletion" ? (r.rows_deleted ?? "–") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
