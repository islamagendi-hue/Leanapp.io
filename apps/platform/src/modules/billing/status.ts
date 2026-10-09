import "server-only";
/**
 * Billing configuration status: what an operator has set up, and what has
 * actually been proven with the provider. States, in order of progress:
 *
 *   not_configured          no STRIPE_* variable is set
 *   missing_credentials     some are set but the secret key or webhook secret is missing or malformed
 *   credentials_unverified  both secrets look right; no verification has run in this mode yet
 *   verification_failed     the last authorized call failed (bad key, missing or wrong prices)
 *   webhook_not_configured  key and prices verified; Stripe has no enabled endpoint at our URL with every event
 *   webhook_unverified      key and prices verified; the key can't list endpoints and no signed event has arrived
 *   connected_verified      key, prices and endpoint verified; no signed event has arrived yet in this mode
 *   ready_test / ready_live everything above, plus at least one correctly signed event received in this mode
 *
 * Verification only runs when keys exist, makes read-only calls (account,
 * prices, webhook endpoints) and stores ids and states, never keys. Checkout
 * is offered only from connected_verified on, and only for prices that passed.
 * An unconfigured provider never limits anyone: plan limits are enforced the
 * same way with or without payments.
 */
import { withSystem } from "@/lib/db";
import { log } from "@/lib/log";
import { publicAppUrl } from "@/server/env";
import { INTERVALS, priceEnvProblems, resolvePriceId, type BillingInterval } from "./plans";
import { billingProvider, type PriceExpectation, type VerificationResult } from "./provider";
import { keyMode, STRIPE_WEBHOOK_EVENTS, type ProviderMode } from "./stripe";

type Env = Record<string, string | undefined>;

export type BillingConfigState =
  | "not_configured"
  | "missing_credentials"
  | "credentials_unverified"
  | "verification_failed"
  | "webhook_not_configured"
  | "webhook_unverified"
  | "connected_verified"
  | "ready_test"
  | "ready_live";

export interface ConfigProblem {
  variable: string;
  problem: string;
}

export interface ConfigShape {
  state: "not_configured" | "missing_credentials" | "credentials_present";
  mode: ProviderMode | null;
  problems: ConfigProblem[];
}

/** What the environment says, before any call to the provider. Names and reasons only, never values. */
export function configShape(env: Env, planIds: string[] = []): ConfigShape {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const hook = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const anyPrice = Object.keys(env).some((k) => /^STRIPE_PRICE_/.test(k) && env[k]?.trim());
  const problems: ConfigProblem[] = [];
  if (!key && !hook) {
    if (!anyPrice) return { state: "not_configured", mode: null, problems };
    problems.push({ variable: "STRIPE_SECRET_KEY", problem: "not set" }, { variable: "STRIPE_WEBHOOK_SECRET", problem: "not set" });
  }
  const mode = keyMode(key);
  if (key && !mode) problems.push({ variable: "STRIPE_SECRET_KEY", problem: "is not a Stripe secret or restricted key (sk_test_, sk_live_, rk_test_, rk_live_)" });
  if (!key && hook) problems.push({ variable: "STRIPE_SECRET_KEY", problem: "not set" });
  if (key && !hook) problems.push({ variable: "STRIPE_WEBHOOK_SECRET", problem: "not set; a paid checkout could never activate a plan" });
  if (hook && !hook.startsWith("whsec_")) problems.push({ variable: "STRIPE_WEBHOOK_SECRET", problem: "is not a webhook signing secret (whsec_…)" });
  problems.push(...priceEnvProblems(env, planIds));
  const credentialsOk = Boolean(mode && hook.startsWith("whsec_"));
  return { state: credentialsOk ? "credentials_present" : "missing_credentials", mode: credentialsOk ? mode : null, problems };
}

export interface StoredCheck {
  checkedAt: Date;
  ok: boolean;
  details: VerificationResult;
}

/** The final state from the environment, the last verification in this mode and the last signed event received in it. */
export function deriveState(shape: ConfigShape, check: StoredCheck | null, lastSignedEventAt: Date | null): BillingConfigState {
  if (shape.state !== "credentials_present") return shape.state;
  if (!check) return "credentials_unverified";
  const d = check.details;
  if (!d.account?.ok || !d.prices?.length || d.prices.some((p) => !p.ok)) return "verification_failed";
  if (lastSignedEventAt) return shape.mode === "live" ? "ready_live" : "ready_test";
  if (d.webhook?.state === "found") return "connected_verified";
  if (d.webhook?.state === "unverifiable") return "webhook_unverified";
  return "webhook_not_configured";
}

/** States in which checkout may be offered (still per price: only prices that passed verification). */
export const CHECKOUT_STATES: ReadonlySet<BillingConfigState> = new Set(["connected_verified", "ready_test", "ready_live"]);

export interface PlanPriceStatus {
  planId: string;
  interval: BillingInterval;
  /** The price id comes from configuration; it is an id, not a secret. */
  priceId: string | null;
  verified: boolean;
  problem?: string;
}

export interface BillingStatus {
  provider: "stripe";
  state: BillingConfigState;
  mode: ProviderMode | null;
  checkoutEnabled: boolean;
  problems: ConfigProblem[];
  lastCheck: StoredCheck | null;
  lastSignedEventAt: Date | null;
  prices: PlanPriceStatus[];
  webhookUrl: string;
}

export const webhookUrl = () => `${publicAppUrl()}/api/webhooks/stripe`;

interface PlanRow {
  id: string;
  checkout: string;
  currency: string;
  price_monthly_cents: string | null;
  price_annual_cents: string | null;
  stripe_price_id: string | null;
}

async function sellablePlans(): Promise<{ all: string[]; selfServe: PlanRow[] }> {
  return withSystem(async (db) => {
    const rows = await db.query<PlanRow>("select id, checkout, currency, price_monthly_cents, price_annual_cents, stripe_price_id from platform.plans order by sort_order");
    return { all: rows.map((r) => r.id), selfServe: rows.filter((r) => r.checkout === "self_serve") };
  });
}

function expectations(env: Env, plans: PlanRow[]): PriceExpectation[] {
  const out: PriceExpectation[] = [];
  for (const p of plans) {
    for (const interval of INTERVALS) {
      const priceId = resolvePriceId(env, p.id, interval, p.stripe_price_id);
      if (!priceId) continue;
      const cents = interval === "month" ? p.price_monthly_cents : p.price_annual_cents;
      out.push({ planId: p.id, interval, priceId, currency: p.currency, amountCents: cents === null ? null : Number(cents) });
    }
  }
  return out;
}

async function lastCheck(mode: ProviderMode): Promise<StoredCheck | null> {
  const row = await withSystem((db) =>
    db.one<{ checked_at: Date; ok: boolean; details: VerificationResult }>(
      "select checked_at, ok, details from platform.billing_provider_checks where provider = 'stripe' and mode = $1 order by checked_at desc, id desc limit 1",
      [mode],
    ),
  );
  return row ? { checkedAt: row.checked_at, ok: row.ok, details: row.details } : null;
}

async function lastSignedEvent(mode: ProviderMode): Promise<Date | null> {
  const row = await withSystem((db) =>
    db.one<{ at: Date | null }>(
      "select max(received_at) as at from platform.billing_events where provider = 'stripe' and livemode = $1 and outcome <> 'mode_mismatch'",
      [mode === "live"],
    ),
  );
  return row?.at ?? null;
}

/** How long a successful verification counts before the status re-checks on its own. */
export const VERIFY_MAX_AGE_MS = 24 * 3600_000;
let inflight: Promise<StoredCheck | null> | null = null;

/**
 * Calls the provider with the configured keys and stores the result. Does
 * nothing (returns null) when credentials aren't present: it never calls out
 * without keys, and never invents a result.
 */
export async function verifyBillingProvider(env: Env = process.env): Promise<StoredCheck | null> {
  const provider = billingProvider(env);
  if (!provider) return null;
  const { selfServe } = await sellablePlans();
  const details = await provider.verify({ prices: expectations(env, selfServe), webhookUrl: webhookUrl(), requiredEvents: STRIPE_WEBHOOK_EVENTS });
  const ok = details.account.ok && details.prices.length > 0 && details.prices.every((p) => p.ok);
  const row = await withSystem((db) =>
    db.one<{ checked_at: Date }>(
      "insert into platform.billing_provider_checks (provider, mode, ok, details) values ('stripe', $1, $2, $3) returning checked_at",
      [provider.mode, ok, JSON.stringify(details)],
    ),
  );
  log.info("billing.provider_verified", { mode: provider.mode, ok, account: details.account.ok, prices: details.prices.length, webhook: details.webhook.state });
  return { checkedAt: row!.checked_at, ok, details };
}

/**
 * The billing configuration status. With `autoVerify`, credentials that are
 * present but unverified (or verified more than a day ago) are verified now,
 * once per process at a time; a failing call leaves the previous state.
 */
export async function billingStatus(opts: { autoVerify?: boolean; env?: Env } = {}): Promise<BillingStatus> {
  const env = opts.env ?? process.env;
  const { all, selfServe } = await sellablePlans();
  const shape = configShape(env, all);
  let check = shape.mode ? await lastCheck(shape.mode) : null;
  if (opts.autoVerify && shape.state === "credentials_present" && (!check || Date.now() - check.checkedAt.getTime() > VERIFY_MAX_AGE_MS)) {
    inflight ??= verifyBillingProvider(env).finally(() => (inflight = null));
    try {
      check = (await inflight) ?? check;
    } catch (err) {
      log.warn("billing.verify_failed", { error_name: err instanceof Error ? err.name : typeof err });
    }
  }
  const signedAt = shape.mode ? await lastSignedEvent(shape.mode) : null;
  const state = deriveState(shape, check, signedAt);
  const verified = new Map((check?.details.prices ?? []).map((p) => [`${p.planId}:${p.interval}:${p.priceId}`, p]));
  const prices: PlanPriceStatus[] = [];
  for (const p of selfServe) {
    for (const interval of INTERVALS) {
      const priceId = resolvePriceId(env, p.id, interval, p.stripe_price_id);
      const v = priceId ? verified.get(`${p.id}:${interval}:${priceId}`) : undefined;
      prices.push({ planId: p.id, interval, priceId, verified: Boolean(v?.ok), problem: priceId ? v?.problem ?? (v ? undefined : "unverified") : "not_configured" });
    }
  }
  return {
    provider: "stripe",
    state,
    mode: shape.mode,
    checkoutEnabled: CHECKOUT_STATES.has(state),
    problems: shape.problems,
    lastCheck: check,
    lastSignedEventAt: signedAt,
    prices,
    webhookUrl: webhookUrl(),
  };
}

/** The verified price for a plan and interval when checkout may use it, else null. */
export function checkoutPrice(status: BillingStatus, planId: string, interval: BillingInterval): string | null {
  if (!status.checkoutEnabled) return null;
  const p = status.prices.find((x) => x.planId === planId && x.interval === interval);
  return p?.verified && p.priceId ? p.priceId : null;
}
