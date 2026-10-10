"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { authorizeUrl, OAUTH_COOKIE, OAUTH_STATE_TTL_SECONDS, redirectUri } from "@/modules/integrations/oauth";
import { isAdProvider } from "@/modules/integrations/registry";
import {
  removeConnection, requestBackfill, saveAdConnection, setCapability, startOAuth, syncNow, verifyConnection,
} from "@/modules/integrations/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { publicAppUrl } from "@/server/env";
import { loadApp, pickEnvironment } from "@/server/session";

const text = (form: FormData, k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
const pagePath = (org: string, app: string, provider?: string) => `/o/${org}/apps/${app}/settings/integrations${provider ? `/${provider}` : ""}`;

/** Fields named `secret.<key>` and `settings.<key>` from the form. */
function prefixed(form: FormData, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith(prefix) && typeof v === "string") out[k.slice(prefix.length)] = v;
  return out;
}

export async function saveAdConnectionAction(org: string, app: string, provider: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app: a, environments } = await loadApp(org, app);
    const env = await pickEnvironment(environments, text(form, "env"));
    const r = await saveAdConnection(ctx, a.id, { environmentId: env.id, provider, secrets: prefixed(form, "secret."), settings: prefixed(form, "settings.") });
    revalidatePath(pagePath(org, app, provider));
    const t = await getT();
    return r.missing.length
      ? { ok: true, message: t("Saved. Still missing: {fields}.", { fields: r.missing.map((m) => t(m)).join(", ") }) }
      : { ok: true, message: msg("Saved. Use Test connection to check the credentials against the provider.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setCapabilityAction(org: string, app: string, provider: string, connectionId: string, capability: string, enabled: boolean, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    await setCapability(ctx, a.id, connectionId, capability, { enabled, spendSource: text(form, "spendSource") || undefined });
    revalidatePath(pagePath(org, app, provider));
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function requestBackfillAction(org: string, app: string, provider: string, connectionId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    await requestBackfill(ctx, a.id, connectionId, text(form, "from") ?? "", a.timezone);
    revalidatePath(pagePath(org, app, provider));
    return { ok: true, message: msg("History import queued. The worker imports 30 days per run, newest first.") };
  } catch (err) {
    return toActionError(err);
  }
}

export async function syncNowAction(org: string, app: string, provider: string, connectionId: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    const r = await syncNow(ctx, a.id, connectionId);
    revalidatePath(pagePath(org, app, provider));
    const t = await getT();
    if (!r.ok) return { error: t("Import failed: {error}", { error: r.error ?? "" }) };
    return { ok: true, message: t("Imported {rows} rows for {from} to {to}.", { rows: r.rows, from: r.from ?? "", to: r.to ?? "" }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function verifyConnectionAction(org: string, app: string, provider: string, connectionId: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    const r = await verifyConnection(ctx, a.id, connectionId);
    revalidatePath(pagePath(org, app, provider));
    const t = await getT();
    if (!r.ok) return { error: t("The provider refused the credentials: {error}", { error: r.error }) };
    return { ok: true, message: t("Connected to the live provider. Ad accounts these credentials can read: {list}", { list: r.accounts.map((x) => (x.name ? `${x.name} (${x.id})` : x.id)).join(", ") || "–" }) };
  } catch (err) {
    return toActionError(err);
  }
}

export async function removeConnectionAction(org: string, app: string, provider: string, connectionId: string, _: ActionState): Promise<ActionState> {
  try {
    const { ctx, app: a } = await loadApp(org, app);
    await removeConnection(ctx, a.id, connectionId);
    revalidatePath(pagePath(org, app, provider));
    return { ok: true, message: msg("Connection removed.") };
  } catch (err) {
    return toActionError(err);
  }
}

/** Starts "Connect with …": stores the state hash, sets the state cookie and sends the browser to the provider. */
export async function startOAuthAction(org: string, app: string, provider: string, _: ActionState, form: FormData): Promise<ActionState> {
  let url: string;
  try {
    if (!isAdProvider(provider)) return { error: msg("Unknown provider.") };
    const { ctx, app: a, environments } = await loadApp(org, app);
    const env = await pickEnvironment(environments, text(form, "env"));
    const { state } = await startOAuth(ctx, a.id, env.id, provider, `${pagePath(org, app, provider)}`);
    (await cookies()).set(OAUTH_COOKIE, state, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/integrations/oauth", maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    url = authorizeUrl(provider, { redirectUri: redirectUri(publicAppUrl(), provider), state });
  } catch (err) {
    return toActionError(err);
  }
  redirect(url);
}
