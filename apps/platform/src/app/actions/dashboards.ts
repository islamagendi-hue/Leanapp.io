"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addWidget, createDashboard, deleteDashboard, removeWidget, saveLayout, updateDashboard, updateWidget } from "@/modules/dashboards/service";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}/analytics/dashboards`;
const field = (form: FormData, k: string) => {
  const v = form.get(k);
  return typeof v === "string" ? v : undefined;
};

export async function createDashboardAction(org: string, app: string, appId: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireTenant(org);
    id = (await createDashboard(ctx, appId, { name: field(form, "name"), description: field(form, "description"), visibility: field(form, "visibility") })).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(org, app)}/${id}`);
}

export async function updateDashboardAction(org: string, app: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await updateDashboard(ctx, id, { name: field(form, "name"), description: field(form, "description"), visibility: field(form, "visibility") });
    revalidatePath(base(org, app));
    return { ok: true, message: "Saved." };
  } catch (err) {
    return toActionError(err);
  }
}

export async function deleteDashboardAction(org: string, app: string, id: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await deleteDashboard(ctx, id);
  } catch (err) {
    return toActionError(err);
  }
  redirect(base(org, app));
}

/**
 * Adds a widget. The form gives `dashboard`, `type` and either `savedReport`
 * or `config` (JSON), plus optional `title`, `w`, `h`.
 */
export async function addWidgetAction(org: string, app: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const dashboard = field(form, "dashboard") ?? "";
    const config = field(form, "config");
    await addWidget(ctx, dashboard, {
      type: field(form, "type"),
      title: field(form, "title"),
      savedReportId: field(form, "savedReport") || undefined,
      config: config ? JSON.parse(config) : undefined,
      w: field(form, "w") || undefined,
      h: field(form, "h") || undefined,
    });
    revalidatePath(`${base(org, app)}/${dashboard}`);
    return { ok: true, message: "Added to the dashboard." };
  } catch (err) {
    if (err instanceof SyntaxError) return { error: "The widget settings aren't valid." };
    return toActionError(err);
  }
}

export async function updateWidgetAction(org: string, app: string, dashboardId: string, widgetId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const config = field(form, "config");
    await updateWidget(ctx, dashboardId, widgetId, { title: field(form, "title"), config: config ? JSON.parse(config) : undefined });
    revalidatePath(`${base(org, app)}/${dashboardId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof SyntaxError) return { error: "The widget settings aren't valid." };
    return toActionError(err);
  }
}

export async function removeWidgetAction(org: string, app: string, dashboardId: string, widgetId: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await removeWidget(ctx, dashboardId, widgetId);
    revalidatePath(`${base(org, app)}/${dashboardId}`);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

/** Saves the grid from a JSON list of {id, x, y, w, h}. */
export async function saveLayoutAction(org: string, app: string, dashboardId: string, layout: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await saveLayout(ctx, dashboardId, JSON.parse(layout));
    revalidatePath(`${base(org, app)}/${dashboardId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof SyntaxError) return { error: "The layout isn't valid." };
    return toActionError(err);
  }
}
