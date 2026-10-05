import { usageSummary } from "@/modules/usage/service";
import { requirePermission, requireTenant } from "@/server/session";

export const metadata = { title: "Plan & usage" };

const num = (n: number) => n.toLocaleString("en-US");

export default async function UsagePage(props: PageProps<"/o/[org]/settings/usage">) {
  const { org } = await props.params;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "billing.read");
  const u = await usageSummary(ctx);
  const month = u.periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Plan &amp; usage</h1>
        <p className="mt-1 text-ink-2">
          You&apos;re on the <strong>{u.plan.name}</strong> plan. Event data is kept for {u.plan.retentionDays ? `${u.plan.retentionDays} days` : "as long as you need"}.
          Billing isn&apos;t connected yet: nothing is charged and going over a limit doesn&apos;t block anything.
        </p>
      </div>
      <section className="card space-y-5">
        <h2 className="h2">{month}</h2>
        <ul className="space-y-5">
          {u.lines.map((l) => {
            const pct = l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : null;
            const over = l.limit !== null && l.used > l.limit;
            const near = pct !== null && pct >= 80;
            return (
              <li key={l.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{l.label}</span>
                  <span className={over ? "font-medium text-alert" : near ? "text-warn" : "text-ink-2"}>
                    {num(l.used)}{l.limit !== null ? ` of ${num(l.limit)}` : l.key === "monthly_active_users" ? "" : " (unlimited)"}
                    {over && " · over the plan limit"}
                  </span>
                </div>
                {pct !== null && (
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={l.label}>
                    <div className={`h-full rounded-full ${over ? "bg-alert" : near ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-ink-3">Events count everything accepted by ingestion in all environments this month (UTC). Monthly active users count distinct users in production.</p>
      </section>
    </div>
  );
}
