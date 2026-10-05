"use server";

import { redirect } from "next/navigation";
import { signIn, signOut, signUp } from "@/modules/auth/service";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { clearSessionCookie, requestMeta, sessionToken, setSessionCookie } from "@/server/session";

function safeNext(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : null;
}

export async function signUpAction(_: ActionState, form: FormData): Promise<ActionState> {
  let next: string;
  try {
    const s = await signUp({ name: form.get("name"), email: form.get("email"), password: form.get("password") }, await requestMeta());
    await setSessionCookie(s.token, s.expiresAt);
    next = safeNext(form.get("next")) ?? "/onboarding";
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
