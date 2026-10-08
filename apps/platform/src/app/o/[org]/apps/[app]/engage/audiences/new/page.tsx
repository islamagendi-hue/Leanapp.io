import Link from "next/link";
import { previewAudienceAction, saveAudienceAction } from "@/app/actions/engage";
import { AudienceEditor } from "@/components/engage/AudienceEditor";
import { knownEvents, knownProperties } from "@/components/engage/shared";
import { loadApp, pickEnvironment, requirePermission } from "@/server/session";

export const metadata = { title: "New audience" };

export default async function NewAudiencePage(props: PageProps<"/o/[org]/apps/[app]/engage/audiences/new">) {
  const { org, app } = await props.params;
  const sp = await props.searchParams;
  const { ctx, app: a, environments } = await loadApp(org, app);
  requirePermission(ctx, "audiences.manage");
  const env = await pickEnvironment(environments, sp.env);
  const events = await knownEvents(ctx, env.id);
  const properties = await knownProperties(ctx, a.id, env.id);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-3"><Link className="hover:underline" href={`/o/${org}/apps/${app}/engage/audiences?env=${env.type}`}>Audiences</Link> / new</p>
        <h1 className="h1">New audience <span className="pill border-line align-middle text-xs">{env.type}</span></h1>
      </div>
      <section className="card">
        <AudienceEditor
          save={saveAudienceAction.bind(null, org, app, env.id, null)}
          preview={previewAudienceAction.bind(null, org, env.id)}
          events={events}
          properties={properties}
          initial={{ name: "", description: "", refreshMinutes: 15, definition: { type: "and", children: [{ type: "event", event: "", did: true, countOp: "gte", count: 1, withinDays: 30, where: [] }] } }}
        />
      </section>
      <p className="text-sm text-ink-3">Saved as a draft. Preview it, then activate it from its page to start computing membership.</p>
    </div>
  );
}
