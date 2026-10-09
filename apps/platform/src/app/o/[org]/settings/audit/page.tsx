import Link from "next/link";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, msg } from "@/i18n/translate";
import { listAuditLogs } from "@/modules/audit/service";
import { requirePermission, requireTenant } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Audit log") };
}

const AREAS = [
  ["", msg("Everything")], ["organization", msg("Organization")], ["member", msg("Members")], ["invitation", msg("Invitations")], ["app", msg("Apps")],
  ["sdk_key", msg("SDK keys")], ["api_key", msg("API keys")], ["tracking_plan", msg("Tracking plan")], ["event_mapping", msg("Mappings")], ["privacy", msg("Privacy")], ["billing", msg("Billing")],
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
  const t = await getT();
  const lang = await getLang();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Audit log")}</h1>
        <p className="mt-1 text-ink-2">{t("Security-relevant changes in {org}: who did what, and when. Entries can't be edited or deleted.", { org: ctx.organizationName })}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {AREAS.map(([key, label]) => (
          <Link key={key} href={key ? `${base}?area=${key}` : base} className={`pill ${area === key ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:text-ink"}`}>
            {t(label)}
          </Link>
        ))}
      </div>
      <div className="card overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">{area ? t("Nothing recorded in this area yet.") : t("Nothing recorded yet.")}</p>
        ) : (
          <table className="table">
            <thead><tr><th>{t("When")}</th><th>{t("Who")}</th><th>{t("Action")}</th><th>{t("Details")}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-xs text-ink-3">{new Date(r.created_at).toLocaleString(dateLocale(lang), { timeZone: "UTC" })} UTC</td>
                  <td className="text-sm">
                    {r.actor_type === "user" ? (r.actor_name ?? t("Former member")) : r.actor_type === "api_key" ? t("Secret API key") : r.actor_type === "system" ? t("LeanApp (automatic)") : t("LeanApp support")}
                    {r.actor_email && <div className="text-xs text-ink-3" dir="ltr">{r.actor_email}</div>}
                  </td>
                  <td className="font-mono text-xs">{r.action}</td>
                  <td className="max-w-md text-xs break-words text-ink-2" dir="ltr">{details(r.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {(before || next) && (
        <div className="flex gap-3 text-sm">
          {before && <Link className="underline" href={area ? `${base}?area=${area}` : base}>{t("Newest")}</Link>}
          {next && <Link className="underline" href={`${base}?${new URLSearchParams({ ...(area ? { area } : {}), before: next })}`}>{t("Older")}</Link>}
        </div>
      )}
    </div>
  );
}
