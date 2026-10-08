"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppBySlug } from "@/modules/apps/service";
import { ADD_WIDGET_TYPES, widgetInputFromForm } from "@/modules/dashboards/form";
import {
  addWidget, createDashboard, createFromTemplate, deleteDashboard, moveWidget, removeWidget, saveLayout, updateDashboard, updateWidget,
} from "@/modules/dashboards/service";
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

/** Adds a widget from the "Add widget" form fields of one type. */
export async function addWidgetFromFormAction(org: string, app: string, dashboardId: string, type: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const t = ADD_WIDGET_TYPES.find((x) => x === type);
    if (!t) return { error: "Choose a widget type." };
    await addWidget(ctx, dashboardId, {
      type: t,
      title: field(form, "title"),
      config: widgetInputFromForm(t, (k) => field(form, k)),
      w: field(form, "w") || undefined,
      h: field(form, "h") || undefined,
    });
  } catch (err) {
    return toActionError(err);
  }
  revalidatePath(`${base(org, app)}/${dashboardId}`);
  redirect(`${base(org, app)}/${dashboardId}?edit=1`);
}

/**
 * Moves (up, down) or resizes (wider, narrower, taller, shorter) one widget;
 * the form's pressed button gives `move`. Failures (a removed widget, lost
 * access) show the error page, since there's nothing to fix in the form.
 */
export async function moveWidgetAction(org: string, app: string, dashboardId: string, widgetId: string, form: FormData): Promise<void> {
  const ctx = await requireTenant(org);
  await moveWidget(ctx, dashboardId, widgetId, field(form, "move"));
  revalidatePath(`${base(org, app)}/${dashboardId}`);
}

/** A new dashboard from a template, built from the selected environment. */
export async function createFromTemplateAction(org: string, app: string, envType: string, template: string, _: ActionState, form: FormData): Promise<ActionState> {
  let id: string;
  try {
    const ctx = await requireTenant(org);
    const { app: a, environments } = await getAppBySlug(ctx, app);
    const env = environments.find((e) => e.type === envType) ?? environments[0];
    id = (await createFromTemplate(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone }, template, { visibility: field(form, "visibility") })).id;
  } catch (err) {
    return toActionError(err);
  }
  redirect(`${base(org, app)}/${id}?env=${envType}`);
}
