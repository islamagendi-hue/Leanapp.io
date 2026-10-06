import Link from "next/link";
import { listAuditLogs } from "@/modules/audit/service";
import { requirePermission, requireTenant } from "@/server/session";

export const metadata = { title: "Audit log" };

const AREAS = [
  ["", "Everything"], ["organization", "Organization"], ["member", "Members"], ["invitation", "Invitations"], ["app", "Apps"],
  ["sdk_key", "SDK keys"], ["api_key", "API keys"], ["tracking_plan", "Tracking plan"], ["event_mapping", "Mappings"], ["privacy", "Privacy"], ["billing", "Billing"],
] as const;

function details(m: Record<string, unknown>): string {
  const parts = Object.entries(m)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const s = parts.join(" · ");
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

export default async function AuditPage(props: PageProps<"/o/[org]/settings/audit">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "audit.read");
  const area = typeof sp.area === "string" ? sp.area : "";
  const before = typeof sp.before === "string" ? sp.before : undefined;
  const { rows, next } = await listAuditLogs(ctx, { area: area || undefined, before });
  const base = `/o/${org}/settings/audit`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Audit log</h1>
        <p className="mt-1 text-ink-2">Security-relevant changes in {ctx.organizationName}: who did what, and when. Entries can&apos;t be edited or deleted.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {AREAS.map(([key, label]) => (
          <Link key={key} href={key ? `${base}?area=${key}` : base} className={`pill ${area === key ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:text-ink"}`}>
            {label}
          </Link>
        ))}
      </div>
      <div className="card overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">Nothing recorded{area ? " in this area" : ""} yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-xs text-ink-3">{new Date(r.created_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</td>
                  <td className="text-sm">
                    {r.actor_type === "user" ? (r.actor_name ?? "Former member") : r.actor_type === "api_key" ? "Secret API key" : r.actor_type === "system" ? "LeanApp (automatic)" : "LeanApp support"}
                    {r.actor_email && <div className="text-xs text-ink-3">{r.actor_email}</div>}
                  </td>
                  <td className="font-mono text-xs">{r.action}</td>
                  <td className="max-w-md text-xs break-words text-ink-2">{details(r.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(before || next) && (
        <div className="flex gap-3 text-sm">
          {before && <Link className="underline" href={area ? `${base}?area=${area}` : base}>Newest</Link>}
          {next && <Link className="underline" href={`${base}?${new URLSearchParams({ ...(area ? { area } : {}), before: next })}`}>Older</Link>}
        </div>
      )}
    </div>
  );
}
