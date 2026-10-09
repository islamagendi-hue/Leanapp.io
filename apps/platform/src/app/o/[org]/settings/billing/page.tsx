import { openBillingPortalAction, startCheckoutAction } from "@/app/actions/billing";
import { ActionForm } from "@/components/ActionForm";
import { getLang, getT } from "@/i18n/server";
import { dateLocale, fmtNumber, msg, type Lang, type T } from "@/i18n/translate";
import type { BillingInterval } from "@/modules/billing/plans";
import { billingOverview, type PaymentsView, type PlanOption } from "@/modules/billing/service";
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
  incomplete_expired: { label: msg("Expired before payment"), tone: "border-line text-ink-3" },
  cancelled: { label: msg("Cancelled"), tone: "border-line text-ink-3" },
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

/** Plan names are product names (kept in English, as on the pricing page), except the evaluation allowance every organization starts on. */
const planLabel = (t: T, id: string, name: string) => (id === "free" ? t("Evaluation") : name);

const INTERVAL_LABEL: Record<BillingInterval, string> = { month: msg("Pay monthly"), year: msg("Pay annually") };

/** The plan's price line: the public monthly price ("from" for usage-based plans), contact sales, or the evaluation allowance. */
function priceLine(p: PlanOption, t: T): string {
  if (p.checkout === "none") return t("Evaluation allowance");
  if (p.checkout === "sales") return t("Contact sales");
  if (p.priceMonthlyCents === null) return t("Price shown at checkout");
  const price = money(p.priceMonthlyCents, p.currency);
  return p.priceIsMinimum ? t("from {price} / month", { price }) : t("{price} / month", { price });
}

/** `reason` explains why the viewer can't buy right now (null = they can). */
function PlanCard({ p, org, reason, t }: { p: PlanOption; org: string; reason: string | null; t: T }) {
  const name = planLabel(t, p.id, p.name);
  return (
    <li className={`card flex flex-col gap-3 ${p.current ? "border-ink" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-bold">{name}</h3>
        {p.current && <span className="pill border-ink">{t("Current")}</span>}
      </div>
      <p className="text-sm text-ink-2">{priceLine(p, t)}</p>
      <ul className="space-y-1 text-sm text-ink-2">
        <li>{p.usageBased && p.limits.events !== null ? t("{n} events / month included, then priced by usage", { n: num(p.limits.events) }) : limitText(t, p.limits.events, msg("Unlimited events / month"), msg("{n} events / month"))}</li>
        <li>{limitText(t, p.limits.apps, msg("Unlimited apps"), msg("{n} apps"), msg("{n} app"))}</li>
        <li>{limitText(t, p.limits.seats, msg("Unlimited members"), msg("{n} members"), msg("{n} member"))}</li>
        <li>{p.limits.retentionDays === null ? t("Unlimited data retention") : t("{n} days of data", { n: num(p.limits.retentionDays) })}</li>
        {p.trialDays !== null && <li>{t("{n}-day trial for a first subscription", { n: p.trialDays })}</li>}
      </ul>
      {p.blockers.length > 0 && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {p.blockers.map((b) => (b.key === "apps"
            ? t("You have {used} apps; this plan includes {limit}. Existing apps stay, but you can't add more.", { used: num(b.used), limit: num(b.limit) })
            : t("You have {used} members and invitations; this plan includes {limit}. Nobody is removed, but you can't invite more.", { used: num(b.used), limit: num(b.limit) }))).join(" ")}
        </p>
      )}
      <div className="mt-auto space-y-2">
        {p.current || p.checkout === "none" ? null : p.checkout === "sales" ? (
          <a className="btn-secondary" href={`mailto:sales@leanapp.io?subject=${encodeURIComponent(`LeanApp ${p.name}`)}`}>{t("Contact sales")}</a>
        ) : reason === null && p.purchasable ? (
          p.prices.filter((x) => x.available).map((x) => (
            <ActionForm
              key={x.interval}
              action={startCheckoutAction.bind(null, org, p.id, x.interval)}
              submitLabel={`${p.change === "downgrade" ? t("Switch to {plan}", { plan: name }) : t("Upgrade to {plan}", { plan: name })} · ${t(INTERVAL_LABEL[x.interval])}`}
              pendingLabel={t("Opening checkout…")}
              className="space-y-2"
            />
          ))
        ) : (
          <>
            <button type="button" className="btn" disabled aria-describedby={`why-${p.id}`}>{t("Upgrade to {plan}", { plan: name })}</button>
            <p id={`why-${p.id}`} className="text-xs text-ink-3">{reason ?? t("Not available for online checkout yet. Contact sales@leanapp.io.")}</p>
          </>
        )}
      </div>
    </li>
  );
}

/** Why plans can't be bought yet, from the payment setup state; null when checkout is open. */
function paymentsReason(p: PaymentsView, t: T): string | null {
  if (p.checkoutEnabled) return null;
  return p.state === "not_configured" ? t("Payments are not connected yet.") : t("Payments are being set up and can't take payments yet.");
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
  const buyReason = paymentsReason(b.payments, t)
    ?? (!b.canManage
      ? t("Only owners can change the plan.")
      : hasLiveSubscription
        ? t("Use Manage billing to change an existing subscription.")
        : null);
  const shownPlans = b.plans.filter((p) => p.checkout !== "none" || p.current);
  const subPlanName = (id: string) => planLabel(t, id, b.plans.find((p) => p.id === id)?.name ?? id);
  const [onPlanBefore, onPlanAfter] = t("You're on the {plan} plan.").split("{plan}");
  const refused = aroundCode(u.eventsRefused === 1
    ? t("{n} event was refused this month because the allowance was used up (error {code}).", { n: num(u.eventsRefused) })
    : t("{n} events were refused this month because the allowance was used up (error {code}).", { n: num(u.eventsRefused) }));
  const howCounted = aroundCode(t("Events count everything ingestion accepted in all environments this month (UTC). Past the allowance, events get a 10% grace; then ingestion refuses them with {code} until the month resets or you upgrade. Owners get an email at 80%, 100% and when events are refused. Apps and members (pending invitations too) can't exceed the plan's limits."));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Plan & billing")}</h1>
        <p className="mt-1 text-ink-2">
          {onPlanBefore}<strong>{planLabel(t, u.plan.id, u.plan.name)}</strong>{onPlanAfter} {u.plan.retentionDays ? t("Event data is kept for {n} days under your current plan.", { n: u.plan.retentionDays }) : t("Event data is kept for as long as you need.")}
        </p>
      </div>

      {b.payments.state === "not_configured" ? (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {t("Payments aren't connected yet. Nothing is charged, and plans can't be bought online for now.")}
        </p>
      ) : !b.payments.checkoutEnabled ? (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {t("Payments are being set up and haven't been verified yet. Nothing is charged, and plans can't be bought online for now.")}
        </p>
      ) : b.payments.mode === "test" ? (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
          {t("Payments are in test mode: checkout accepts only Stripe test cards and nothing is charged.")}
        </p>
      ) : null}
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
                {subPlanName(sub.plan_id)}{" "}
                <span className={`pill ms-1 ${STATUS[sub.status]?.tone ?? "border-line"}`}>{STATUS[sub.status] ? t(STATUS[sub.status].label) : sub.status}</span>
                {sub.billing_interval && <> · {sub.billing_interval === "year" ? t("Billed annually") : t("Billed monthly")}</>}
                <br />
                {t("Current period {start} to {end}.", { start: day(sub.current_period_start), end: day(sub.current_period_end) })}
                {sub.status === "trialing" && sub.trial_end && <> {t("The trial ends on {date}; the first payment is taken then.", { date: day(sub.trial_end) })}</>}
                {sub.cancel_at_period_end && <> {t("Cancels at the end of this period, then the organization returns to the evaluation allowance.")}</>}
                {sub.status === "past_due" && <> {t("Stripe is retrying the payment; update the card in Manage billing to keep the plan.")}</>}
                {sub.status === "incomplete" && <> {t("The first payment hasn't gone through. The plan starts once it does; otherwise the subscription expires.")}</>}
                {(sub.status === "unpaid" || sub.status === "paused") && <> {t("The paid plan doesn't apply while the subscription isn't paid. Update the payment method in Manage billing.")}</>}
              </p>
            ) : (
              <>
                <p className="mt-1 text-sm text-ink-2">{t("No paid subscription. Usage is metered per calendar month (UTC): {start} to {end}.", { start: day(u.periodStart), end: day(new Date(u.periodEnd.getTime() - 1)) })}</p>
                {b.endedSubscription && (
                  <p className="mt-1 text-sm text-ink-3">
                    {t("The {plan} subscription ended on {date}.", { plan: subPlanName(b.endedSubscription.plan_id), date: day(b.endedSubscription.ended_at ?? b.endedSubscription.current_period_end) })}
                  </p>
                )}
              </>
            )}
          </div>
          {b.canManage && b.hasBillingAccount && b.payments.checkoutEnabled && (
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
        {b.overageEvents > 0 && (
          <p className="rounded-lg bg-paper-2 px-3 py-2 text-sm text-ink-2">
            {t("{n} events above the plan's included allowance this month. Usage-based billing isn't charged yet; nothing extra is billed for them.", { n: num(b.overageEvents) })}
          </p>
        )}
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
          {shownPlans.map((p) => <PlanCard key={p.id} p={p} org={org} reason={buyReason} t={t} />)}
        </ul>
        <p className="text-xs text-ink-3">{t("Prices in US dollars, as on our pricing page. Annual prices are shown at checkout. Payment happens on Stripe; card details never reach LeanApp.")}</p>
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
                  <td>
                    <span className={`pill ${STATUS[i.status]?.tone ?? "border-line"}`}>{STATUS[i.status] ? t(STATUS[i.status].label) : i.status}</span>
                    {Number(i.amount_refunded_cents) > 0 && <span className="ms-2 text-xs text-ink-3" dir="ltr">{t("Refunded {amount}", { amount: money(Number(i.amount_refunded_cents), i.currency) })}</span>}
                  </td>
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
