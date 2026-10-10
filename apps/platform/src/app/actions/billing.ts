"use server";

import { redirect } from "next/navigation";
import { openBillingPortal, startCheckout } from "@/modules/billing/service";
import { isAllowedProviderRedirect, PaymentProviderError } from "@/modules/billing/stripe";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

/**
 * Sends the owner to Stripe Checkout for `planId` billed every `interval`
 * (month or year). Price, amount and currency are resolved on the server.
 * Errors (e.g. payments not connected) come back as form state.
 */
export async function startCheckoutAction(orgSlug: string, planId: string, interval: string, _: ActionState): Promise<ActionState> {
  let url: string;
  try {
    url = await startCheckout(await requireTenant(orgSlug), planId, interval);
    // Only ever redirect to the provider's own Checkout host.
    if (!isAllowedProviderRedirect(url)) throw new PaymentProviderError();
  } catch (err) {
    return toActionError(err);
  }
  redirect(url);
}

/** Sends the owner to the Stripe Customer Portal. */
export async function openBillingPortalAction(orgSlug: string, _: ActionState): Promise<ActionState> {
  let url: string;
  try {
    url = await openBillingPortal(await requireTenant(orgSlug));
    if (!isAllowedProviderRedirect(url)) throw new PaymentProviderError();
  } catch (err) {
    return toActionError(err);
  }
  redirect(url);
}
