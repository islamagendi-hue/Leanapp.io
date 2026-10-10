import "server-only";
/**
 * The billing provider boundary. Billing code (service.ts, status.ts,
 * reconcile.ts) works against this interface; the only implementation is the
 * Stripe adapter (stripe-adapter.ts, over stripe.ts). A second provider (e.g.
 * for Mada / SAR invoicing) would implement the same interface and its own
 * webhook handler; nothing else would change.
 *
 * No provider is returned when it isn't configured: callers show a disabled
 * state and never fall back to a simulated one.
 */
import type { BillingInterval } from "./plans";
import { stripeAdapter } from "./stripe-adapter";
import { stripeConfig, type ProviderMode } from "./stripe";

export interface CheckoutRequest {
  organizationId: string;
  customerId: string;
  planId: string;
  interval: BillingInterval;
  /** Resolved on the server from configuration; never from the client. */
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays: number | null;
  idempotencyKey: string;
}

export interface PriceExpectation {
  planId: string;
  interval: BillingInterval;
  priceId: string;
  currency: string;
  /** Expected unit amount in cents when the plan has a fixed list price; null = not checked (usage-based or not set). */
  amountCents: number | null;
}

export interface PriceCheck {
  planId: string;
  interval: BillingInterval;
  priceId: string;
  ok: boolean;
  /** missing, inactive, not_recurring, wrong_interval, wrong_currency, wrong_mode, amount_differs, unreadable */
  problem?: string;
  /** Stripe's amount, for the report when it differs. */
  amountCents?: number | null;
}

export interface WebhookEndpointCheck {
  /** found: an enabled endpoint at our URL with every required event; others say what's wrong. */
  state: "found" | "missing" | "disabled" | "missing_events" | "unverifiable";
  url: string;
  missingEvents?: string[];
}

export interface VerificationResult {
  ok: boolean;
  mode: ProviderMode;
  account: { ok: boolean; problem?: "key_invalid" | "key_forbidden" | "unreachable"; chargesEnabled?: boolean | null; id?: string | null };
  prices: PriceCheck[];
  webhook: WebhookEndpointCheck;
}

export interface BillingProvider {
  readonly id: "stripe";
  readonly mode: ProviderMode;
  createCustomer(input: { organizationId: string; name: string; email?: string | null }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(input: CheckoutRequest): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** The provider's current view of a subscription (for reconciliation); null when it no longer exists. */
  getSubscription(id: string): Promise<Record<string, unknown> | null>;
  /** Read-only authorized calls that prove the credentials, prices and webhook endpoint. */
  verify(input: { prices: PriceExpectation[]; webhookUrl: string; requiredEvents: readonly string[] }): Promise<VerificationResult>;
}

/** The configured provider, or null when payments aren't connected. */
export function billingProvider(env: Record<string, string | undefined> = process.env): BillingProvider | null {
  const config = stripeConfig(env);
  return config ? stripeAdapter(config) : null;
}
