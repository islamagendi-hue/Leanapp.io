import { getT } from "@/i18n/server";
import { dateLocale, msg, type Lang } from "@/i18n/translate";
import { topEvents } from "@/modules/analytics/service";
import { readPlan } from "@/modules/implementation/editor";
import { catalogForPickers, options } from "@/modules/properties/catalog";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

/** A date and time; pass the reader's language for Arabic month names (English by default). */
export const fmtDate = (d: Date | string | null, lang: Lang = "en") => (d ? new Date(d).toLocaleString(dateLocale(lang), { dateStyle: "medium", timeStyle: "short" }) : "–");

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
  scheduled: "border-warn/40 text-warn",
  sending: "border-line-strong text-ink-2",
  sent: "border-accent/40 text-accent-ink",
  recurring: "border-accent/40 bg-accent-soft text-accent-ink",
};

/** Status names as shown (the stored value with "_" as a space). */
const STATUS_TEXT: Record<string, string> = {
  draft: msg("draft"), active: msg("active"), paused: msg("paused"), archived: msg("archived"), completed: msg("completed"),
  succeeded: msg("succeeded"), failed: msg("failed"), giving_up: msg("giving up"), cancelled: msg("cancelled"), pending: msg("pending"),
  waiting: msg("waiting"), running: msg("running"), disabled: msg("disabled"), scheduled: msg("scheduled"), sending: msg("sending"),
  sent: msg("sent"), recurring: msg("recurring"),
};

export async function StatusPill({ status }: { status: string }) {
  const t = await getT();
  return <span className={`pill ${PILL[status] ?? "border-line"}`}>{t(STATUS_TEXT[status] ?? status.replace("_", " "))}</span>;
}

/** Event names seen in the environment, for autocompletion (empty when the member can't read analytics). */
export async function knownEvents(ctx: TenantContext, environmentId: string): Promise<string[]> {
  if (!can(ctx.role, "analytics.read")) return [];
  return (await topEvents(ctx, { environmentId, days: 90 })).map((e) => e.name);
}

/** Event names in the app's published tracking plan (null when there's none, or the member can't read it). */
export async function plannedEvents(ctx: TenantContext, appId: string): Promise<string[] | null> {
  if (!can(ctx.role, "implementation.read")) return null;
  const plan = await readPlan({ kind: "user", ctx }, appId, "published");
  return plan ? plan.events.map((e) => e.event_name) : null;
}

/**
 * User and event property names with observed values from the property
 * catalog, for condition suggestions (empty when the member can't read audiences).
 */
export async function knownProperties(ctx: TenantContext, appId: string, environmentId: string) {
  if (!can(ctx.role, "audiences.read")) return { user: [], event: [] };
  const c = await catalogForPickers(ctx, { appId, environmentId }, "audiences.read");
  const pick = (list: ReturnType<typeof options>) => list.map((o) => ({ name: o.name, values: o.values }));
  return { user: pick(options(c.user)), event: pick(options(c.event)) };
}

/** Small server-rendered line of a series (audience size history). */
export async function Sparkline({ values, label }: { values: number[]; label: string }) {
  const t = await getT();
  if (values.length < 2) return <p className="text-sm text-ink-3">{t("Size history appears after a few computations.")}</p>;
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
