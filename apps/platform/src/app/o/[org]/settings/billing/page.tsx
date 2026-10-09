import { openBillingPortalAction, startCheckoutAction } from "@/app/actions/billing";
import { ActionForm } from "@/components/ActionForm";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber, msg, type Lang, type T } from "@/i18n/translate";
import { billingOverview, type PlanOption } from "@/modules/billing/service";
import type { UsageLine } from "@/modules/usage/service";
import { requirePermission, requireTenant } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Plan & billing") };
}

const num = (n: number) => fmtNumber(n);
const dayIn = (lang: Lang) => (d: Date) => new Date(d).toLocaleDateString(dateLocale(lang), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
/** A plan limit: `unlimited` when null, `one` when exactly 1, else `many` with {n}. */
const limitText = (t: T, n: number | null, unlimited: string, many: string, one = many) => (n === null ? t(unlimited) : t(n === 1 ? one : many, { n: num(n) }));
/** Splits a translated sentence at `{code}` so an inline code element can go there. */
const aroundCode = (s: string) => s.split("{code}");

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: msg("Active"), tone: "border-accent/40 text-accent-ink" },
  trialing: { label: msg("Trial"), tone: "border-accent/40 text-accent-ink" },
  past_due: { label: msg("Payment failed, retrying"), tone: "border-warn/40 text-warn" },
  unpaid: { label: msg("Unpaid"), tone: "border-alert/40 text-alert" },
  paused: { label: msg("Paused"), tone: "border-warn/40 text-warn" },
  incomplete: { label: msg("Awaiting payment"), tone: "border-warn/40 text-warn" },
  paid: { label: msg("Paid"), tone: "border-accent/40 text-accent-ink" },
  open: { label: msg("Due"), tone: "border-warn/40 text-warn" },
  void: { label: msg("Void"), tone: "border-line text-ink-3" },
  uncollectible: { label: msg("Uncollectible"), tone: "border-alert/40 text-alert" },
  draft: { label: msg("Draft"), tone: "border-line text-ink-3" },
};

function UsageBar({ l, t }: { l: UsageLine; t: T }) {
  const pct = l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : null;
  const tone = l.state === "blocked" || l.state === "over" ? "alert" : l.state === "warning" ? "warn" : null;
  let status = "";
  if (l.key === "events" && l.state === "blocked") status = t("refusing new events");
  else if (l.key === "events" && l.state === "over") status = t("over the allowance, accepted until {cap} (10% grace)", { cap: num(l.hardCap!) });
  else if (l.state === "over") status = t("at the plan limit");
  else if (l.state === "warning") status = t("nearing the limit");
  const label = t(l.label);
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={tone === "alert" ? "font-medium text-alert" : tone === "warn" ? "text-warn" : "text-ink-2"}>
          {l.limit !== null ? t("{used} of {limit}", { used: num(l.used), limit: num(l.limit) }) : l.key === "monthly_active_users" ? num(l.used) : t("{used} (unlimited)", { used: num(l.used) })}
          {status && ` · ${status}`}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`h-full rounded-full ${tone === "alert" ? "bg-alert" : tone === "warn" ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {l.note && <p className="mt-1 text-xs text-ink-3">{l.note}</p>}
    </li>
  );
}

/** `reason` explains why the viewer can't buy right now (null = they can). */
function PlanCard({ p, org, connected, reason, t }: { p: PlanOption; org: string; connected: boolean; reason: string | null; t: T }) {
  return (
    <li className={`card flex flex-col gap-3 ${p.current ? "border-ink" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-bold">{p.name}</h3>
        {p.current && <span className="pill border-ink">{t("Current")}</span>}
      </div>
      <p className="text-sm text-ink-2">
        {p.priceMonthlyCents !== null ? t("{price} / month", { price: money(p.priceMonthlyCents, p.currency) }) : p.id === "free" ? t("Free") : p.id === "enterprise" ? t("Contact sales") : p.purchasable ? t("Price shown at checkout") : t("Price not set yet")}
      </p>
      <ul className="space-y-1 text-sm text-ink-2">
        <li>{limitText(t, p.limits.events, msg("Unlimited events / month"), msg("{n} events / month"))}</li>
        <li>{limitText(t, p.limits.apps, msg("Unlimited apps"), msg("{n} apps"), msg("{n} app"))}</li>
        <li>{limitText(t, p.limits.seats, msg("Unlimited members"), msg("{n} members"), msg("{n} member"))}</li>
        <li>{p.limits.retentionDays === null ? t("Unlimited data retention") : t("{n} days of data", { n: num(p.limits.retentionDays) })}</li>
      </ul>
      <div className="mt-auto">
        {p.current || p.id === "free" ? null : reason === null && p.purchasable ? (
          <ActionForm action={startCheckoutAction.bind(null, org, p.id)} submitLabel={t("Upgrade to {plan}", { plan: p.name })} pendingLabel={t("Opening checkout…")} className="space-y-2" />
        ) : (
          <>
            <button type="button" className="btn" disabled aria-describedby={`why-${p.id}`}>{t("Upgrade to {plan}", { plan: p.name })}</button>
            <p id={`why-${p.id}`} className="mt-2 text-xs text-ink-3">
              {connected && !p.purchasable ? t("Not available for online checkout yet. Contact sales@leanapp.io.") : reason}
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
  const [t, lang] = await Promise.all([getT(), getLang()]);
  const day = dayIn(lang);
  const u = b.usage;
  const month = u.periodStart.toLocaleDateString(dateLocale(lang), { month: "long", year: "numeric", timeZone: "UTC" });
  const sub = b.subscription;
  const hasLiveSubscription = Boolean(sub);
  const buyReason = !b.paymentsConnected
    ? t("Payments are not connected yet.")
    : !b.canManage
      ? t("Only owners can change the plan.")
      : hasLiveSubscription
        ? t("Use Manage billing to change an existing subscription.")
        : null;
  const paidPlans = b.plans.filter((p) => p.id !== "free" || p.current);
  const [onPlanBefore, onPlanAfter] = t("You're on the {plan} plan.").split("{plan}");
  const refused = aroundCode(u.eventsRefused === 1
    ? t("{n} event was refused this month because the allowance was used up (error {code}).", { n: num(u.eventsRefused) })
    : t("{n} events were refused this month because the allowance was used up (error {code}).", { n: num(u.eventsRefused) }));
  const howCounted = aroundCode(t("Events count everything accepted by ingestion in all environments this month (UTC). Past the monthly allowance, events are still accepted for a 10% grace; after that ingestion refuses them with {code} until the month resets or you upgrade. Owners get an email at 80%, 100% and when events are refused. Apps and members (including pending invitations) can't be added beyond the plan."));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Plan & billing")}</h1>
        <p className="mt-1 text-ink-2">
          {onPlanBefore}<strong>{u.plan.name}</strong>{onPlanAfter} {u.plan.retentionDays ? t("Event data is kept for {n} days.", { n: u.plan.retentionDays }) : t("Event data is kept for as long as you need.")}
        </p>
      </div>

      {!b.paymentsConnected && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {t("Payments are not connected yet. Nothing is charged, and plans can't be bought online until LeanApp connects its payment provider.")}
        </p>
      )}
      {sp.checkout === "success" && (
        <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent-ink" role="status">
          {t("Checkout finished. Your plan changes here as soon as Stripe confirms the payment, usually within a minute. Refresh to see it.")}
        </p>
      )}
      {sp.checkout === "cancelled" && <p className="rounded-lg bg-paper-2 px-4 py-3 text-sm text-ink-2" role="status">{t("Checkout was cancelled. Nothing was charged.")}</p>}

      <section className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="h2">{t("Subscription")}</h2>
            {sub ? (
              <p className="mt-1 text-sm text-ink-2">
                {b.plans.find((p) => p.id === sub.plan_id)?.name ?? sub.plan_id}{" "}
                <span className={`pill ms-1 ${STATUS[sub.status]?.tone ?? "border-line"}`}>{STATUS[sub.status] ? t(STATUS[sub.status].label) : sub.status}</span>
                <br />
                {t("Current period {start} to {end}.", { start: day(sub.current_period_start), end: day(sub.current_period_end) })}
                {sub.cancel_at_period_end && <> {t("Cancels at the end of this period, then the organization returns to Free.")}</>}
                {sub.status === "past_due" && <> {t("Stripe is retrying the payment; update the card in Manage billing to keep the plan.")}</>}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-2">{t("No paid subscription. Usage is metered per calendar month (UTC): {start} to {end}.", { start: day(u.periodStart), end: day(new Date(u.periodEnd.getTime() - 1)) })}</p>
            )}
          </div>
          {b.canManage && b.hasBillingAccount && b.paymentsConnected && (
            <ActionForm action={openBillingPortalAction.bind(null, org)} submitLabel={t("Manage billing")} pendingLabel={t("Opening…")} buttonClass="btn-secondary" className="space-y-2" />
          )}
        </div>
        {!b.canManage && <p className="text-xs text-ink-3">{t("Only owners can change the plan or payment details.")}</p>}
      </section>

      <section id="usage" className="card scroll-mt-24 space-y-5">
        <h2 className="h2">{t("Usage in {month}", { month })}</h2>
        <ul className="space-y-5">
          {u.lines.map((l) => <UsageBar key={l.key} l={l} t={t} />)}
        </ul>
        {u.eventsRefused > 0 && (
          <p className="rounded-lg bg-alert-soft px-3 py-2 text-sm text-alert">
            {refused[0]}<code className="font-mono">plan_limit_exceeded</code>{refused[1]}
          </p>
        )}
        <p className="text-xs text-ink-3">
          {howCounted[0]}<code className="font-mono">plan_limit_exceeded</code>{howCounted[1]}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="h2">{t("Plans")}</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {paidPlans.map((p) => <PlanCard key={p.id} p={p} org={org} connected={b.paymentsConnected} reason={buyReason} t={t} />)}
        </ul>
        <p className="text-xs text-ink-3">{t("Plans and limits are placeholders until pricing is final. Payment happens on Stripe; card details never reach LeanApp.")}</p>
      </section>

      <section className="card overflow-x-auto p-0">
        <h2 className="h2 px-4 pt-4">{t("Invoices")}</h2>
        {b.invoices.length === 0 ? (
          <p className="p-4 text-sm text-ink-3">{t("No invoices yet.")}</p>
        ) : (
          <table className="table mt-2">
            <thead><tr><th>{t("Invoice")}</th><th>{t("Period")}</th><th>{t("Amount")}</th><th>{t("Status")}</th><th /></tr></thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono text-xs">{i.number ?? "—"}</td>
                  <td className="text-ink-2">{day(i.period_start)} – {day(i.period_end)}</td>
                  <td dir="ltr" className="text-start">{money(Number(i.amount_cents), i.currency)}</td>
                  <td><span className={`pill ${STATUS[i.status]?.tone ?? "border-line"}`}>{STATUS[i.status] ? t(STATUS[i.status].label) : i.status}</span></td>
                  <td className="text-end text-sm">
                    {i.hosted_invoice_url && <a className="underline" href={i.hosted_invoice_url} target="_blank" rel="noreferrer">{t("View")}</a>}
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
