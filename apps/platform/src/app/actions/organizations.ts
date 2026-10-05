"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { acceptInvitation, changeMemberRole, createOrganization, inviteMember, removeMember, revokeInvitation } from "@/modules/organizations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { publicAppUrl } from "@/server/env";
import { requireTenant, requireUser } from "@/server/session";

export async function createOrganizationAction(_: ActionState, form: FormData): Promise<ActionState> {
  let slug: string;
  try {
    const user = await requireUser();
    const org = await createOrganization(user.id, {
      name: form.get("name"),
      country: form.get("country") ?? "",
      timezone: form.get("timezone") || "UTC",
      defaultCurrency: form.get("currency") || "USD",
      industry: form.get("industry") ?? "",
    });
    slug = org.slug;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/o/${slug}/apps/new`);
}

export async function inviteMemberAction(orgSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(orgSlug);
    const { token } = await inviteMember(ctx, { email: form.get("email"), role: form.get("role") });
    revalidatePath(`/o/${orgSlug}/settings/members`);
    return { ok: true, message: "Invitation created. Email delivery isn't connected yet, so send this link yourself:", secret: `${publicAppUrl()}/invite/${token}` };
  } catch (err) {
    return toActionError(err);
  }
}

export async function changeRoleAction(orgSlug: string, userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await changeMemberRole(await requireTenant(orgSlug), userId, form.get("role"));
    revalidatePath(`/o/${orgSlug}/settings/members`);
    return { ok: true, message: "Role updated." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeMemberAction(orgSlug: string, userId: string, _: ActionState): Promise<ActionState> {
  try {
    await removeMember(await requireTenant(orgSlug), userId);
    revalidatePath(`/o/${orgSlug}/settings/members`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function revokeInvitationAction(orgSlug: string, invitationId: string, _: ActionState): Promise<ActionState> {
  try {
    await revokeInvitation(await requireTenant(orgSlug), invitationId);
    revalidatePath(`/o/${orgSlug}/settings/members`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function acceptInvitationAction(token: string, _: ActionState): Promise<ActionState> {
  let slug: string;
  try {
    const user = await requireUser();
    slug = (await acceptInvitation(user, token)).slug;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/o/${slug}`);
}
