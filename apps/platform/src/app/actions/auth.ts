"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { sendVerificationEmail } from "@/modules/auth/account";
import { signIn, signOut, signUp } from "@/modules/auth/service";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { clearSessionCookie, requestMeta, sessionToken, setSessionCookie } from "@/server/session";
import { log } from "@/lib/log";
import { safeNext } from "@/lib/safe-next";

export async function signUpAction(_: ActionState, form: FormData): Promise<ActionState> {
  let next: string;
  try {
    const s = await signUp({ name: form.get("name"), email: form.get("email"), password: form.get("password") }, await requestMeta());
    await setSessionCookie(s.token, s.expiresAt);
    const back = safeNext(form.get("next"));
    // Sent after the response so a slow or failing email provider never blocks sign-up.
    // The link returns to `next` (an invitation, typically), which needs a confirmed email.
    after(() => sendVerificationEmail(s.user.id, { next: back }).catch((e) => log.error("email.verification_failed", { user_id: s.user.id, error: e })));
    next = back ?? "/onboarding";
  } catch (err) {
    return toActionError(err);
  }
  redirect(next);
}

export async function signInAction(_: ActionState, form: FormData): Promise<ActionState> {
  let next: string;
  try {
    const s = await signIn({ email: form.get("email"), password: form.get("password") }, await requestMeta());
    await setSessionCookie(s.token, s.expiresAt);
    const orgs = await listOrganizationsForUser(s.user.id);
    next = safeNext(form.get("next")) ?? (orgs.length === 1 ? `/o/${orgs[0].slug}` : "/onboarding");
  } catch (err) {
    return toActionError(err);
  }
  redirect(next);
}

export async function signOutAction() {
  await signOut(await sessionToken());
  await clearSessionCookie();
  redirect("/login");
}
