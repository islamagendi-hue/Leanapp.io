"use server";

import { redirect } from "next/navigation";
import { changePassword, requestPasswordReset, resetPassword, sendVerificationEmail, signOutOtherSessions, verifyEmail } from "@/modules/auth/account";
import { safeNext } from "@/lib/safe-next";
import { toActionError, type ActionState } from "@/server/action-result";
import { requestMeta, requireUser, sessionToken } from "@/server/session";

export async function requestPasswordResetAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    await requestPasswordReset({ email: form.get("email") }, await requestMeta());
    return { ok: true, message: "If an account exists for that email, a reset link is on its way. It expires in 1 hour." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resetPasswordAction(token: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    if (form.get("password") !== form.get("confirm")) return { error: "The passwords don't match." };
    await resetPassword(token, form.get("password"));
  } catch (err) {
    return toActionError(err);
  }
  redirect("/login?reset=1");
}

export async function verifyEmailAction(token: string, next: string | null, _: ActionState): Promise<ActionState> {
  try {
    const r = await verifyEmail(token);
    if (!r) return { error: "This link is invalid, expired, or was already used. Sign in and send a new one from your account page." };
  } catch (err) {
    return toActionError(err);
  }
  redirect(safeNext(next) ?? "/account?verified=1");
}

/** An optional hidden `next` field brings the user back there (e.g. to an invitation) after confirming. */
export async function resendVerificationAction(_: ActionState, form?: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const r = await sendVerificationEmail(user.id, { next: safeNext(form?.get("next")) });
    if (r.transport === "skipped") return { ok: true, message: "Your email is already confirmed." };
    if (!r.delivered) return { error: "Email delivery isn't configured on this server yet, so the confirmation email couldn't be sent." };
    return { ok: true, message: `Sent to ${user.email}. The link expires in 24 hours.` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (form.get("newPassword") !== form.get("confirm")) return { error: "The new passwords don't match." };
    await changePassword(user.id, { currentPassword: form.get("currentPassword"), newPassword: form.get("newPassword") }, (await sessionToken()) ?? null);
    return { ok: true, message: "Password changed. Your other sessions were signed out." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function signOutOtherSessionsAction(_: ActionState): Promise<ActionState> {
  try {
    const user = await requireUser();
    const n = await signOutOtherSessions(user.id, (await sessionToken()) ?? null);
    return { ok: true, message: n ? `Signed out ${n} other session${n > 1 ? "s" : ""}.` : "No other sessions were active." };
  } catch (err) {
    return toActionError(err);
  }
}
