import { requestDeletionAction } from "@/app/actions/privacy";
import { ActionForm } from "@/components/ActionForm";
import { CodeTabs } from "@/components/CodeTabs";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { listPrivacyRequests } from "@/modules/privacy/service";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Privacy requests" };

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString("en-GB") : "–");

export default async function PrivacyPage(props: PageProps<"/o/[org]/apps/[app]/privacy">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "privacy.manage");
  const env = pickEnvironment(environments, sp.env);
  const requests = await listPrivacyRequests(ctx, env.id);
  const api = publicBaseUrl();
  const base = `/o/${org}/apps/${app}/privacy`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Privacy requests</h1>
          <p className="mt-1 max-w-2xl text-ink-2">
            Export or delete everything stored about one of your app&apos;s users in this environment. Use the user&apos;s ID, an install&apos;s anonymous ID, or both.
          </p>
        </div>
        <EnvSwitcher path={base} current={env.type} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-3">
          <h2 className="h2">Export a user&apos;s data</h2>
          <p className="text-sm text-ink-3">Downloads a JSON file with their events, sessions, profile, installs, push tokens and consent.</p>
          <form action={`${base}/export`} method="get" className="space-y-3">
            <input type="hidden" name="environment" value={env.id} />
            <label className="block"><span className="label">User ID</span><input name="user_id" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">Anonymous ID</span><input name="anonymous_id" className="input" maxLength={256} /></label>
            <button className="btn-secondary" type="submit">Download export</button>
          </form>
        </section>

        <section className="card space-y-3">
          <h2 className="h2">Delete a user&apos;s data</h2>
          <p className="text-sm text-ink-3">
            Permanent. Removes their events, sessions, profile and push tokens in the {env.type} environment. Anonymous activity on a device shared with
            another user is kept, because it can&apos;t be attributed. Stop sending events for them first, or new data will arrive.
          </p>
          <ActionForm action={requestDeletionAction.bind(null, org, app, env.id)} submitLabel="Delete data" buttonClass="btn-danger" className="space-y-3">
            <label className="block"><span className="label">User ID</span><input name="userId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">Anonymous ID</span><input name="anonymousId" className="input" maxLength={256} /></label>
            <label className="block"><span className="label">Type &quot;delete&quot; to confirm</span><input name="confirm" className="input" autoComplete="off" required /></label>
          </ActionForm>
        </section>
      </div>

      <section className="card space-y-3">
        <h2 className="h2">From your backend</h2>
        <p className="text-sm text-ink-3">Use a secret API key of this environment. Deletions run in the background; poll the returned ID for the result.</p>
        <CodeTabs
          preferred="delete"
          tabs={[
            {
              key: "delete",
              label: "Delete",
              code: `curl -X POST ${api}/v1/privacy/deletions \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123"}'

# → 202 {"id":"…","status":"received"}
curl ${api}/v1/privacy/deletions/<id> -H "Authorization: Bearer $LEANAPP_SECRET_KEY"`,
            },
            {
              key: "export",
              label: "Export",
              code: `curl -X POST ${api}/v1/privacy/exports \\
  -H "Authorization: Bearer $LEANAPP_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id":"user_123"}'`,
            },
          ]}
        />
      </section>

      <section className="card space-y-3">
        <h2 className="h2">History</h2>
        {requests.length === 0 ? (
          <p className="text-sm text-ink-3">No requests in this environment yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Requested</th><th>Type</th><th>Subject</th><th>By</th><th>Status</th><th>Rows deleted</th></tr></thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="text-ink-3">{fmt(r.created_at)}</td>
                    <td>{r.kind}</td>
                    <td className="font-mono text-xs break-all">
                      {r.subject_user_id && <div>user: {r.subject_user_id}</div>}
                      {r.subject_anonymous_id && <div>anon: {r.subject_anonymous_id}</div>}
                    </td>
                    <td>{r.requested_by_name ?? "API key"}</td>
                    <td>
                      {r.job_status === "failed" ? <span className="text-alert" title={r.error ?? ""}>failed</span> : r.status}
                      {r.job_status === "queued" && r.error && <div className="text-xs text-ink-3">retrying</div>}
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
