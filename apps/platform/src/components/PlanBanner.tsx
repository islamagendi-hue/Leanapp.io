import Link from "next/link";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber } from "@/i18n/translate";
import { eventAllowance } from "@/modules/billing/enforcement";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

const num = (n: number) => fmtNumber(n);

/**
 * Organization-wide notice about the monthly event allowance. Reads the same
 * short-lived cache ingestion uses, so it costs at most one small query per
 * organization per cache window. Refusing and over-limit states are shown to
 * everyone (data stops arriving for all of them); the 80% warning only to
 * people who can see billing.
 */
export async function PlanBanner({ ctx }: { ctx: TenantContext }) {
  const a = await eventAllowance(ctx.organizationId);
  if (a.limit === null || a.state === "ok") return null;
  const billing = can(ctx.role, "billing.read");
  if (a.state === "warning" && !billing) return null;
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const resets = a.periodEnd.toLocaleDateString(dateLocale(lang), { day: "numeric", month: "long", timeZone: "UTC" });
  const link = billing ? <> <Link href={`/o/${ctx.organizationSlug}/settings/billing`} className="underline">{can(ctx.role, "billing.manage") ? t("Upgrade the plan") : t("See plan & billing")}</Link></> : <> {t("Ask an owner to upgrade the plan.")}</>;
  // Translated whole; {code} marks where the error code goes.
  const [before, after] = t("Event ingestion is paused: this organization used its {limit} monthly events plus the 10% grace. New events are refused with {code} until {date}.", { limit: num(a.limit), date: resets }).split("{code}");
  const [tone, text] =
    a.state === "blocked"
      ? ["bg-alert-soft text-alert", <>{before}<code className="font-mono">plan_limit_exceeded</code>{after}</>]
      : a.state === "over"
        ? ["bg-warn-soft text-warn", <>{t("This organization is over its {limit} monthly events ({used} used). Events are accepted up to {cap}, then refused until {date}.", { limit: num(a.limit), used: num(a.used), cap: num(a.hardCap!), date: resets })}</>]
        : ["bg-warn-soft text-warn", <>{t("This organization has used {pct}% of its {limit} monthly events.", { pct: Math.floor((a.used / a.limit) * 100), limit: num(a.limit) })}</>];
  return (
    <div className={`border-b border-line px-4 py-2 text-center text-sm ${tone}`} role={a.state === "blocked" ? "alert" : "status"}>
      {text}{link}
    </div>
  );
}
