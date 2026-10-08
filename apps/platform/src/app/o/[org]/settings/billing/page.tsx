import { openBillingPortalAction, startCheckoutAction } from "@/app/actions/billing";
import { ActionForm } from "@/components/ActionForm";
import { billingOverview, type PlanOption } from "@/modules/billing/service";
import type { UsageLine } from "@/modules/usage/service";
import { requirePermission, requireTenant } from "@/server/session";

export const metadata = { title: "Plan & billing" };

const num = (n: number) => n.toLocaleString("en-US");
const day = (d: Date) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const limitText = (n: number | null, unit: string) => (n === null ? `Unlimited ${unit}` : `${num(n)} ${unit}`);

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "border-accent/40 text-accent-ink" },
  trialing: { label: "Trial", tone: "border-accent/40 text-accent-ink" },
  past_due: { label: "Payment failed, retrying", tone: "border-warn/40 text-warn" },
  unpaid: { label: "Unpaid", tone: "border-alert/40 text-alert" },
  paused: { label: "Paused", tone: "border-warn/40 text-warn" },
  incomplete: { label: "Awaiting payment", tone: "border-warn/40 text-warn" },
  paid: { label: "Paid", tone: "border-accent/40 text-accent-ink" },
  open: { label: "Due", tone: "border-warn/40 text-warn" },
  void: { label: "Void", tone: "border-line text-ink-3" },
  uncollectible: { label: "Uncollectible", tone: "border-alert/40 text-alert" },
  draft: { label: "Draft", tone: "border-line text-ink-3" },
};

function UsageBar({ l }: { l: UsageLine }) {
  const pct = l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : null;
  const tone = l.state === "blocked" || l.state === "over" ? "alert" : l.state === "warning" ? "warn" : null;
  let status = "";
  if (l.key === "events" && l.state === "blocked") status = " · refusing new events";
  else if (l.key === "events" && l.state === "over") status = ` · over the allowance, accepted until ${num(l.hardCap!)} (10% grace)`;
  else if (l.state === "over") status = " · at the plan limit";
  else if (l.state === "warning") status = " · nearing the limit";
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{l.label}</span>
        <span className={tone === "alert" ? "font-medium text-alert" : tone === "warn" ? "text-warn" : "text-ink-2"}>
          {num(l.used)}
          {l.limit !== null ? ` of ${num(l.limit)}` : l.key === "monthly_active_users" ? "" : " (unlimited)"}
          {status}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={l.label}>
          <div className={`h-full rounded-full ${tone === "alert" ? "bg-alert" : tone === "warn" ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {l.note && <p className="mt-1 text-xs text-ink-3">{l.note}</p>}
    </li>
  );
}

/** `reason` explains why the viewer can't buy right now (null = they can). */
function PlanCard({ p, org, connected, reason }: { p: PlanOption; org: string; connected: boolean; reason: string | null }) {
  return (
    <li className={`card flex flex-col gap-3 ${p.current ? "border-ink" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-bold">{p.name}</h3>
        {p.current && <span className="pill border-ink">Current</span>}
      </div>
      <p className="text-sm text-ink-2">
        {p.priceMonthlyCents !== null ? `${money(p.priceMonthlyCents, p.currency)} / month` : p.id === "free" ? "Free" : p.id === "enterprise" ? "Contact sales" : p.purchasable ? "Price shown at checkout" : "Price not set yet"}
      </p>
      <ul className="space-y-1 text-sm text-ink-2">
        <li>{limitText(p.limits.events, "events / month")}</li>
        <li>{limitText(p.limits.apps, "apps")}</li>
        <li>{limitText(p.limits.seats, "members")}</li>
        <li>{p.limits.retentionDays === null ? "Unlimited data retention" : `${num(p.limits.retentionDays)} days of data`}</li>
      </ul>
      <div className="mt-auto">
        {p.current || p.id === "free" ? null : reason === null && p.purchasable ? (
          <ActionForm action={startCheckoutAction.bind(null, org, p.id)} submitLabel={`Upgrade to ${p.name}`} pendingLabel="Opening checkout…" className="space-y-2" />
        ) : (
          <>
            <button type="button" className="btn" disabled aria-describedby={`why-${p.id}`}>Upgrade to {p.name}</button>
            <p id={`why-${p.id}`} className="mt-2 text-xs text-ink-3">
              {connected && !p.purchasable ? "Not available for online checkout yet. Contact sales@leanapp.io." : reason}
            </p>
          </>
        )}
      </div>
    </li>
  );
}

export default async function BillingPage(props: PageProps<"/o/[org]/settings/billing">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const ctx = await requireTenant(org);
  requirePermission(ctx, "billing.read");
  const b = await billingOverview(ctx);
  const u = b.usage;
  const month = u.periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const sub = b.subscription;
  const hasLiveSubscription = Boolean(sub);
  const buyReason = !b.paymentsConnected
    ? "Payments are not connected yet."
    : !b.canManage
      ? "Only owners can change the plan."
      : hasLiveSubscription
        ? "Use Manage billing to change an existing subscription."
        : null;
  const paidPlans = b.plans.filter((p) => p.id !== "free" || p.current);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Plan &amp; billing</h1>
        <p className="mt-1 text-ink-2">
          You&apos;re on the <strong>{u.plan.name}</strong> plan. Event data is kept for {u.plan.retentionDays ? `${u.plan.retentionDays} days` : "as long as you need"}.
        </p>
      </div>

      {!b.paymentsConnected && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          Payments are not connected yet. Nothing is charged, and plans can&apos;t be bought online until LeanApp connects its payment provider.
        </p>
      )}
      {sp.checkout === "success" && (
        <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent-ink" role="status">
          Checkout finished. Your plan changes here as soon as Stripe confirms the payment, usually within a minute. Refresh to see it.
        </p>
      )}
      {sp.checkout === "cancelled" && <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-ink-2" role="status">Checkout was cancelled. Nothing was charged.</p>}

      <section className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="h2">Subscription</h2>
            {sub ? (
              <p className="mt-1 text-sm text-ink-2">
                {b.plans.find((p) => p.id === sub.plan_id)?.name ?? sub.plan_id}{" "}
                <span className={`pill ms-1 ${STATUS[sub.status]?.tone ?? "border-line"}`}>{STATUS[sub.status]?.label ?? sub.status}</span>
                <br />
                Current period {day(sub.current_period_start)} to {day(sub.current_period_end)}.
                {sub.cancel_at_period_end && <> Cancels at the end of this period, then the organization returns to Free.</>}
                {sub.status === "past_due" && <> Stripe is retrying the payment; update the card in Manage billing to keep the plan.</>}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">No paid subscription. Usage is metered per calendar month (UTC): {day(u.periodStart)} to {day(new Date(u.periodEnd.getTime() - 1))}.</p>
            )}
          </div>
          {b.canManage && b.hasBillingAccount && b.paymentsConnected && (
            <ActionForm action={openBillingPortalAction.bind(null, org)} submitLabel="Manage billing" pendingLabel="Opening…" buttonClass="btn-secondary" className="space-y-2" />
          )}
        </div>
        {!b.canManage && <p className="text-xs text-ink-3">Only owners can change the plan or payment details.</p>}
      </section>

      <section id="usage" className="card scroll-mt-24 space-y-5">
        <h2 className="h2">Usage in {month}</h2>
        <ul className="space-y-5">
          {u.lines.map((l) => <UsageBar key={l.key} l={l} />)}
        </ul>
        {u.eventsRefused > 0 && (
          <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
            {num(u.eventsRefused)} event{u.eventsRefused === 1 ? " was" : "s were"} refused this month because the allowance was used up (error <code className="font-mono">plan_limit_exceeded</code>).
          </p>
        )}
        <p className="text-xs text-ink-3">
          Events count everything accepted by ingestion in all environments this month (UTC). Past the monthly allowance, events are still accepted for a 10% grace; after that ingestion refuses them with <code className="font-mono">plan_limit_exceeded</code> until the month resets or you upgrade. Owners get an email at 80%, 100% and when events are refused. Apps and members (including pending invitations) can&apos;t be added beyond the plan.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="h2">Plans</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {paidPlans.map((p) => <PlanCard key={p.id} p={p} org={org} connected={b.paymentsConnected} reason={buyReason} />)}
        </ul>
        <p className="text-xs text-ink-3">Plans and limits are placeholders until pricing is final. Payment happens on Stripe; card details never reach LeanApp.</p>
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-4 pt-4">Invoices</h2>
        {b.invoices.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">No invoices yet.</p>
        ) : (
          <table className="table mt-2">
            <thead><tr><th>Invoice</th><th>Period</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono text-xs">{i.number ?? "—"}</td>
                  <td className="text-ink-2">{day(i.period_start)} – {day(i.period_end)}</td>
                  <td>{money(Number(i.amount_cents), i.currency)}</td>
                  <td><span className={`pill ${STATUS[i.status]?.tone ?? "border-line"}`}>{STATUS[i.status]?.label ?? i.status}</span></td>
                  <td className="text-end text-sm">
                    {i.hosted_invoice_url && <a className="underline" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">View</a>}
                    {i.invoice_pdf_url && <a className="ms-3 underline" href={i.invoice_pdf_url} target="_blank" rel="noreferrer">PDF</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
