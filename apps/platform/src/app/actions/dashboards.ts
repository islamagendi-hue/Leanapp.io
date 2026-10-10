"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getT } from "@/i18n/server";
import { msg } from "@/i18n/translate";
import { getAppBySlug } from "@/modules/apps/service";
import { ADD_WIDGET_TYPES, widgetInputFromForm } from "@/modules/dashboards/form";
import {
  addWidget, createDashboard, createFromTemplate, deleteDashboard, moveWidget, removeWidget, saveLayout, updateDashboard, updateWidget,
  DASHBOARD_MESSAGES,
} from "@/modules/dashboards/service";
import { localize } from "@/modules/dashboards/localize";
import { toActionError, type ActionState } from "@/server/action-result";
import { requireTenant } from "@/server/session";

const base = (org: string, app: string) => `/o/${org}/apps/${app}/analytics/dashboards`;
const MESSAGES = [...DASHBOARD_MESSAGES, msg("You don't have permission to do that."), msg("Something went wrong. Please try again.")];

/** The form error for a failure, in the person's language. */
async function fail(err: unknown): Promise<ActionState> {
  const r = toActionError(err);
  const t = await getT();
  const tr = (m: string) => localize(m, t, MESSAGES);
  return {
    ...r,
    error: r.error && tr(r.error),
    fieldErrors: r.fieldErrors && Object.fromEntries(Object.entries(r.fieldErrors).map(([k, v]) => [k, tr(v)])),
  };
}

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
    return fail(err);
  }
  redirect(`${base(org, app)}/${id}`);
}

export async function updateDashboardAction(org: string, app: string, id: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await updateDashboard(ctx, id, { name: field(form, "name"), description: field(form, "description"), visibility: field(form, "visibility") });
    revalidatePath(base(org, app));
    return { ok: true, message: (await getT())(msg("Saved.")) };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteDashboardAction(org: string, app: string, id: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await deleteDashboard(ctx, id);
  } catch (err) {
    return fail(err);
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
    return { ok: true, message: (await getT())(msg("Added to the dashboard.")) };
  } catch (err) {
    if (err instanceof SyntaxError) return { error: (await getT())(msg("The widget settings aren't valid.")) };
    return fail(err);
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
    if (err instanceof SyntaxError) return { error: (await getT())(msg("The widget settings aren't valid.")) };
    return fail(err);
  }
}

export async function removeWidgetAction(org: string, app: string, dashboardId: string, widgetId: string): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    await removeWidget(ctx, dashboardId, widgetId);
    revalidatePath(`${base(org, app)}/${dashboardId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
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
    if (err instanceof SyntaxError) return { error: (await getT())(msg("The layout isn't valid.")) };
    return fail(err);
  }
}

/** Adds a widget from the "Add widget" form fields of one type. */
export async function addWidgetFromFormAction(org: string, app: string, dashboardId: string, type: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requireTenant(org);
    const t = ADD_WIDGET_TYPES.find((x) => x === type);
    if (!t) return { error: (await getT())(msg("Choose a widget type.")) };
    await addWidget(ctx, dashboardId, {
      type: t,
      title: field(form, "title"),
      config: widgetInputFromForm(t, (k) => field(form, k)),
      w: field(form, "w") || undefined,
      h: field(form, "h") || undefined,
    });
  } catch (err) {
    return fail(err);
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
    id = (await createFromTemplate(ctx, { appId: a.id, environmentId: env.id, timezone: a.timezone }, template, { visibility: field(form, "visibility"), t: await getT() })).id;
  } catch (err) {
    return fail(err);
  }
  redirect(`${base(org, app)}/${id}?env=${envType}`);
}
