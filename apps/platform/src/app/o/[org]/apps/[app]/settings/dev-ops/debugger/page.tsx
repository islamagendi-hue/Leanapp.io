import { EventDebugger } from "@/components/EventDebugger";
import { listKeys } from "@/modules/credentials/service";
import { testEventCurl } from "@/modules/implementation/codegen";
import { can } from "@/modules/rbac/authorize";
import { publicBaseUrl } from "@/server/env";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "Event debugger" };

export default async function DebuggerPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/debugger">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "events.read");
  const env = await pickEnvironment(environments, sp.env);
  let pk = "<your public SDK key>";
  if (can(ctx.role, "credentials.read")) {
    const keys = await listKeys(ctx, a.id);
    const active = keys.sdkKeys.find((k) => k.environment_id === env.id && k.status === "active" && (!k.expires_at || new Date(k.expires_at) > new Date()));
    if (active) pk = active.key;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="h1">Event debugger</h1>
          <p className="mt-1 text-ink-2">Every event this environment receives, as it arrives, checked against your published tracking plan.</p>
        </div>
      </div>
      {/* key forces a fresh feed when the environment changes */}
      <EventDebugger key={env.id} feedUrl={`/v1/organizations/${org}/environments/${env.id}/events`} testCurl={testEventCurl(publicBaseUrl(), pk)} />
    </div>
  );
}
