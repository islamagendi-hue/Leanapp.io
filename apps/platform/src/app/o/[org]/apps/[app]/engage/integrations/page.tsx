import { configureIntegrationAction, removeIntegrationAction } from "@/app/actions/engage";
import { ActionForm } from "@/components/ActionForm";
import { EnvSwitcher } from "@/components/EnvSwitcher";
import { fmtDate } from "@/components/engage/shared";
import { secretsAvailable } from "@/lib/secret-box";
import { listIntegrations, type IntegrationRow } from "@/modules/messaging/integrations";
import { can } from "@/modules/rbac/authorize";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Integrations" };

const UNVERIFIED = "Built to the FCM HTTP v1 and APNs token-auth specifications and tested against local mocks; not yet verified with live FCM/APNs.";

export default async function IntegrationsPage(props: PageProps<"/o/[org]/apps/[app]/engage/integrations">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, environments } = await loadApp(org, app);
  requirePermission(ctx, "integrations.read");
  const env = pickEnvironment(environments, sp.env);
  const rows = await listIntegrations(ctx, env.id);
  const manage = can(ctx.role, "integrations.manage");
  const keyReady = secretsAvailable();
  const by = (p: string) => rows.find((r) => r.provider === p);
  const configure = (p: "fcm" | "apns" | "resend") => configureIntegrationAction.bind(null, org, app, env.id, p);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Integrations</h1>
          <p className="mt-1 max-w-2xl text-ink-2">Delivery channels for automations in the <strong>{env.type}</strong> environment. Each environment has its own credentials, so test pushes never reach production users.</p>
        </div>
        <EnvSwitcher path={`/o/${org}/apps/${app}/engage/integrations`} current={env.type} />
      </div>
      {!keyReady && (
        <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
          Credentials can&apos;t be stored on this server: <code>INTEGRATIONS_ENCRYPTION_KEY</code> is not configured. Nothing below can be connected until the operator sets it.
        </p>
      )}

      <Provider title="Firebase Cloud Messaging (Android, and iOS through Firebase)" row={by("fcm")} note={UNVERIFIED} manage={manage} org={org} app={app}>
        <ActionForm action={configure("fcm")} submitLabel={by("fcm") ? "Replace credentials" : "Connect FCM"} className="space-y-3">
          <label className="block"><span className="label">Service account key (JSON)</span><input type="file" name="serviceAccount" accept="application/json,.json" className="input py-2" /></label>
          <p className="help">Firebase console → Project settings → Service accounts → Generate new private key. Needs the &quot;Firebase Cloud Messaging API Admin&quot; role.</p>
        </ActionForm>
      </Provider>

      <Provider title="Apple Push Notification service (iOS)" row={by("apns")} note={UNVERIFIED} manage={manage} org={org} app={app}>
        <ActionForm action={configure("apns")} submitLabel={by("apns") ? "Replace credentials" : "Connect APNs"} className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">Key ID</span><input name="keyId" className="input font-mono" maxLength={10} required /></label>
          <label className="block"><span className="label">Team ID</span><input name="teamId" className="input font-mono" maxLength={10} required /></label>
          <label className="block"><span className="label">Bundle ID</span><input name="bundleId" className="input font-mono" placeholder="com.example.app" required /></label>
          <label className="block"><span className="label">APNs environment</span>
            <select name="apnsEnvironment" className="input" defaultValue={env.type === "production" ? "production" : "sandbox"}>
              <option value="sandbox">Sandbox (development builds)</option>
              <option value="production">Production (TestFlight / App Store)</option>
            </select>
          </label>
          <label className="block sm:col-span-2"><span className="label">Auth key (.p8)</span><input type="file" name="p8File" accept=".p8" className="input py-2" required /></label>
        </ActionForm>
      </Provider>

      <Provider title="Email to your users (Resend)" row={by("resend")} note="Sends from your own Resend account and domain. Messages go to the user's email property, never to people with a recorded marketing opt-out." manage={manage} org={org} app={app}>
        <ActionForm action={configure("resend")} submitLabel={by("resend") ? "Replace credentials" : "Connect Resend"} className="grid gap-3 sm:grid-cols-2">
          <label className="block"><span className="label">API key</span><input name="apiKey" type="password" className="input font-mono" autoComplete="off" required /></label>
          <label className="block"><span className="label">From</span><input name="from" className="input" placeholder="My App <hello@myapp.com>" required /></label>
        </ActionForm>
      </Provider>
    </div>
  );
}

function Provider({ title, row, note, manage, org, app, children }: { title: string; row?: IntegrationRow; note: string; manage: boolean; org: string; app: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="h2">{title}</h2>
          <p className="text-sm">
            {row ? (
              <span className={row.last_error ? "text-alert" : "text-accent-ink"}>
                Connected{Object.entries(row.config).length ? ` · ${Object.entries(row.config).map(([k, v]) => `${k}: ${v}`).join(" · ")}` : ""}
              </span>
            ) : <span className="text-ink-3">Not connected: these messages are logged as failed, never as sent.</span>}
          </p>
          {row && <p className="text-xs text-ink-3">Last used {fmtDate(row.last_used_at)}{row.last_error ? ` · last error: ${row.last_error}` : ""}</p>}
          <p className="mt-1 text-xs text-ink-3">{note}</p>
        </div>
        {row && manage && <ActionForm action={removeIntegrationAction.bind(null, org, app, row.id)} submitLabel="Disconnect" buttonClass="btn-danger" className="space-y-2" confirm="Disconnect and delete these credentials?" />}
      </div>
      {manage && children}
    </section>
  );
}
