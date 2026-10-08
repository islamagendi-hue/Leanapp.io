"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createApp } from "@/modules/apps/service";
import { createApiKey, createSdkKey, revokeApiKey, revokeSdkKey, rotateSdkKey } from "@/modules/credentials/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

export async function createAppAction(orgSlug: string, _: ActionState, form: FormData): Promise<ActionState> {
  let slug: string;
  try {
    const ctx = await requireTenant(orgSlug);
    const app = await createApp(ctx, {
      name: form.get("name"),
      description: form.get("description") || undefined,
      category: form.get("category") || undefined,
      platforms: form.getAll("platforms"),
      defaultCurrency: form.get("currency") || undefined,
    });
    slug = app.slug;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`/o/${orgSlug}/apps/${slug}/settings/dev-ops/implementation/questions`);
}

const keysPath = (org: string, app: string) => `/o/${org}/apps/${app}/settings/dev-ops/sdk`;

export async function createSdkKeyAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState): Promise<ActionState> {
  try {
    await createSdkKey(await requireTenant(orgSlug), environmentId, "Additional");
    revalidatePath(keysPath(orgSlug, appSlug));
    return { ok: true, message: "Key created." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function rotateSdkKeyAction(orgSlug: string, appSlug: string, keyId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    await rotateSdkKey(await requireTenant(orgSlug), keyId, Number(form.get("graceHours") ?? 72));
    revalidatePath(keysPath(orgSlug, appSlug));
    return { ok: true, message: "New key issued. The old key keeps working until its grace period ends." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function revokeSdkKeyAction(orgSlug: string, appSlug: string, keyId: string, _: ActionState): Promise<ActionState> {
  try {
    await revokeSdkKey(await requireTenant(orgSlug), keyId);
    revalidatePath(keysPath(orgSlug, appSlug));
    return { ok: true, message: "Key revoked." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createApiKeyAction(orgSlug: string, appSlug: string, environmentId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { key } = await createApiKey(await requireTenant(orgSlug), environmentId, {
      label: form.get("label") || undefined,
      expiresInDays: form.get("expiresInDays") || undefined,
      scopes: form.getAll("scopes"),
    });
    revalidatePath(keysPath(orgSlug, appSlug));
    return { ok: true, secret: key };
  } catch (err) {
    return toActionError(err);
  }
}

export async function revokeApiKeyAction(orgSlug: string, appSlug: string, keyId: string, _: ActionState): Promise<ActionState> {
  try {
    await revokeApiKey(await requireTenant(orgSlug), keyId);
    revalidatePath(keysPath(orgSlug, appSlug));
    return { ok: true, message: "Key revoked." };
  } catch (err) {
    return toActionError(err);
  }
}
