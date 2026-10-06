"use server";

import { redirect } from "next/navigation";
import { openBillingPortal, startCheckout } from "@/modules/billing/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

/** Sends the owner to Stripe Checkout for `planId`. Errors (e.g. payments not connected) come back as form state. */
export async function startCheckoutAction(orgSlug: string, planId: string, _: ActionState): Promise<ActionState> {
  let url: string;
  try {
    url = await startCheckout(await requireTenant(orgSlug), planId);
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
  } catch (err) {
    return toActionError(err);
  }
  redirect(url);
}
