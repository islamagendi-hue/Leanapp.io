import Link from "next/link";
import { eventAllowance } from "@/modules/billing/enforcement";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";

const num = (n: number) => n.toLocaleString("en-US");

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
  const resets = a.periodEnd.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
  const link = billing ? <> <Link href={`/o/${ctx.organizationSlug}/settings/billing`} className="underline">{can(ctx.role, "billing.manage") ? "Upgrade the plan" : "See plan & billing"}</Link></> : <> Ask an owner to upgrade the plan.</>;
  const [tone, text] =
    a.state === "blocked"
      ? ["bg-alert-soft text-alert", <>Event ingestion is paused: this organization used its {num(a.limit)} monthly events plus the 10% grace. New events are refused with <code className="font-mono">plan_limit_exceeded</code> until {resets}.</>]
      : a.state === "over"
        ? ["bg-warn-soft text-warn", <>This organization is over its {num(a.limit)} monthly events ({num(a.used)} used). Events are accepted up to {num(a.hardCap!)}, then refused until {resets}.</>]
        : ["bg-warn-soft text-warn", <>This organization has used {Math.floor((a.used / a.limit) * 100)}% of its {num(a.limit)} monthly events.</>];
  return (
    <div className={`border-b border-line px-4 py-2 text-center text-sm ${tone}`} role={a.state === "blocked" ? "alert" : "status"}>
      {text}{link}
    </div>
  );
}
