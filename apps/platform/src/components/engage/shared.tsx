import { topEvents } from "@/modules/analytics/service";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

export const fmtDate = (d: Date | string | null) => (d ? new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "–");

const PILL: Record<string, string> = {
  draft: "border-line text-ink-3",
  active: "border-accent/40 bg-accent-soft text-accent-ink",
  paused: "border-warn/40 bg-warn-soft text-warn",
  archived: "border-line text-ink-3",
  completed: "border-accent/40 text-accent-ink",
  succeeded: "border-accent/40 text-accent-ink",
  failed: "border-alert/40 text-alert",
  giving_up: "border-alert/40 bg-alert-soft text-alert",
  cancelled: "border-line text-ink-3",
  pending: "border-warn/40 text-warn",
  waiting: "border-line-strong text-ink-2",
  running: "border-line-strong text-ink-2",
  disabled: "border-line text-ink-3",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${PILL[status] ?? "border-line"}`}>{status.replace("_", " ")}</span>;
}

/** Event names seen in the environment, for autocompletion (empty when the member can't read analytics). */
export async function knownEvents(ctx: TenantContext, environmentId: string): Promise<string[]> {
  if (!can(ctx.role, "analytics.read")) return [];
  return (await topEvents(ctx, { environmentId, days: 90 })).map((e) => e.name);
}

/** Small server-rendered line of a series (audience size history). */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <p className="text-sm text-ink-3">Size history appears after a few computations.</p>;
  const W = 600;
  const H = 80;
  const max = Math.max(1, ...values);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - 4 - (v / max) * (H - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" role="img" aria-label={label} preserveAspectRatio="none">
      <polyline fill="none" stroke="#0f6b4f" strokeWidth="2" vectorEffect="non-scaling-stroke" points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
    </svg>
  );
}
