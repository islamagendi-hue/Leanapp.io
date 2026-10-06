import "server-only";
import type { Db } from "@/lib/db";
import { consentState, suppressedKeys, type Channel as SuppressionChannel } from "@/modules/privacy/consent";

/**
 * Messaging eligibility for automation sends, on top of the privacy module's
 * consent state and suppression lists (src/modules/privacy/consent.ts).
 *
 * Every automation message is treated as marketing, so a person is skipped
 * when any of these hold for their user key in the environment:
 *   - a `marketing` suppression (manual, API, or automatic from denied
 *     marketing consent), or a suppression on the medium itself
 *     (`push`, `email`, `whatsapp`; in-app has no medium list);
 *   - their latest consent decision for `marketing` is a denial, or for
 *     push, their latest `push` decision is a denial.
 * No decision recorded means allowed (apps that don't collect consent keep
 * working); see docs/automation.md.
 */
export type MessageChannel = "push" | "email" | "in_app" | "whatsapp";

export function splitUserKey(userKey: string): { userId: string | null; anonymousId: string | null } {
  return userKey.startsWith("anon:") ? { userId: null, anonymousId: userKey.slice(5) } : { userId: userKey, anonymousId: null };
}

const MEDIUM: Record<MessageChannel, SuppressionChannel | null> = { push: "push", email: "email", whatsapp: "whatsapp", in_app: null };

/** Returns why the person may not receive this channel ("suppressed" | "consent_denied"), or null when they may. */
export async function messagingBlocked(db: Db, environmentId: string, userKey: string, channel: MessageChannel): Promise<string | null> {
  const medium = MEDIUM[channel];
  if ((await suppressedKeys(environmentId, [userKey], "marketing", db)).size) return "suppressed";
  if (medium && (await suppressedKeys(environmentId, [userKey], medium, db)).size) return "suppressed";
  const state = await consentState(environmentId, userKey, db);
  if (state.marketing === false) return "consent_denied";
  if (channel === "push" && state.push === false) return "consent_denied";
  return null;
}
