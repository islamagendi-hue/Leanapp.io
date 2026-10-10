"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { changePassword, requestPasswordReset, resetPassword, sendVerificationEmail, signOutOtherSessions, updateProfile, verifyEmail } from "@/modules/auth/account";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { safeNext } from "@/lib/safe-next";
import { DEMO_LOCKED, isDemoUser } from "@/modules/marketing/demo";
import { toActionError, type ActionState } from "@/server/action-result";
import { requestMeta, requireUser, sessionToken } from "@/server/session";

export async function requestPasswordResetAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await requestPasswordReset({ email: form.get("email") }, await requestMeta());
    return { ok: true, message: msg("If an account exists for that email, a reset link is on its way. It expires in 1 hour.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resetPasswordAction(token: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    if (form.get("password") !== form.get("confirm")) return { error: msg("The passwords don't match.") };
    await resetPassword(token, form.get("password"));
  } catch (err) {
    return toActionError(err);
  }
  redirect("/login?reset=1");
}

export async function verifyEmailAction(token: string, next: string | null, _: ActionState): Promise<ActionState> {
  try {
    const r = await verifyEmail(token);
    if (!r) return { error: msg("This link is invalid, expired, or was already used. Sign in and send a new one from your account page.") };
  } catch (err) {
    return toActionError(err);
  }
  redirect(safeNext(next) ?? "/account?verified=1");
}

/** An optional hidden `next` field brings the user back there (e.g. to an invitation) after confirming. */
export async function resendVerificationAction(_: ActionState, form?: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (isDemoUser(user)) return { error: DEMO_LOCKED };
    const r = await sendVerificationEmail(user.id, { next: safeNext(form?.get("next")) });
    if (r.transport === "skipped") return { ok: true, message: msg("Your email is already confirmed.") };
    if (!r.delivered) return { error: msg("Email delivery isn't configured on this server yet, so the confirmation email couldn't be sent.") };
    const t = await getT();
    return { ok: true, message: t("Sent to {email}. The link expires in 24 hours.", { email: user.email }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (isDemoUser(user)) return { error: DEMO_LOCKED };
    if (form.get("newPassword") !== form.get("confirm")) return { error: msg("The new passwords don't match.") };
    await changePassword(user.id, { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }, (await sessionToken()) ?? null);
    return { ok: true, message: msg("Password changed. Your other sessions were signed out.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function signOutOtherSessionsAction(_: ActionState): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (isDemoUser(user)) return { error: DEMO_LOCKED };
    const n = await signOutOtherSessions(user.id, (await sessionToken()) ?? null);
    const t = await getT();
    return { ok: true, message: n > 1 ? t("Signed out {n} other sessions.", { n }) : n ? t("Signed out {n} other session.", { n }) : t("No other sessions were active.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateProfileAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (isDemoUser(user)) return { error: DEMO_LOCKED };
    await updateProfile(user.id, { name: form.get("name") });
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: msg("Saved.") };
}
