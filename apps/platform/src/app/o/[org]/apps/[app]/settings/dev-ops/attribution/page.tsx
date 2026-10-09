import { updateSettingsAction } from "@/app/actions/attribution";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { getSettings } from "@/modules/attribution/service";
import { rich } from "@/components/acquisition/rich";
import { getT } from "@/i18n/server";
import { loadApp, requirePermission } from "@/server/session";

export async function generateMetadata() {
  return { title: (await getT())("Attribution settings") };
}

export default async function AttributionSettingsPage(props: PageProps<"/o/[org]/apps/[app]/settings/dev-ops/attribution">) {
  const { org, app } = await props.params;
  const { ctx, app: a } = await loadApp(org, app);
  requirePermission(ctx, "attribution.read");
  const s = await getSettings(ctx, a.id);
  const manage = can(ctx.role, "attribution.manage");
  const t = await getT();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">{t("Attribution settings")}</h1>
        <p className="mt-1 max-w-2xl text-ink-2">{t("Matching rules for this app, in every environment. Changes apply to installs and conversions processed from now on.")}</p>
      </div>
      <section className="card max-w-2xl">
        <ActionForm action={updateSettingsAction.bind(null, org, app)} submitLabel={t("Save settings")} className="space-y-5">
          <fieldset disabled={!manage} className="space-y-5">
            <label className="block"><span className="label">{t("Click lookback (days)")}</span>
              <input name="clickLookbackDays" type="number" min={1} max={90} defaultValue={s.click_lookback_days} className="input w-32" />
              <span className="help">{t("An install matches a click (link click id, store referrer or ad-network click id) up to this long after it. Default 7.")}</span>
            </label>
            <label className="block"><span className="label">{t("Conversion window (days)")}</span>
              <input name="conversionWindowDays" type="number" min={1} max={730} defaultValue={s.conversion_window_days} className="input w-32" />
              <span className="help">{t("Conversions this long after the install or re-engagement are credited to its source. Default 90.")}</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" name="reengagementEnabled" defaultChecked={s.reengagement_enabled} className="mt-1" />
              <span><span className="font-medium">{t("Re-engagement")}</span><span className="help block">{t("A user who already has the app and opens it from a newer LeanApp link is credited to that link (last touch).")}</span></span>
            </label>
            <div className="space-y-2 rounded-lg border border-line p-4">
              <label className="flex items-start gap-2">
                <input type="checkbox" name="probabilisticEnabled" defaultChecked={s.probabilistic_enabled} className="mt-1" />
                <span>
                  <span className="font-medium">{t("Probabilistic matching (Android only)")}</span>
                  <span className="help block">
                    {rich(t("When nothing deterministic matches, credit an Android install to an unclaimed link click from the same network address (keyed hash, never the raw IP) and Android version within the window below. Reported separately as {probabilistic}. Never used on iOS. Off by default: turn it on only if your privacy notice discloses it."), {
                      probabilistic: <em>{t("probabilistic")}</em>,
                    })}
                  </span>
                </span>
              </label>
              <label className="block ps-6"><span className="label">{t("Window (hours)")}</span>
                <input name="probabilisticWindowHours" type="number" min={1} max={168} defaultValue={s.probabilistic_window_hours} className="input w-32" />
              </label>
            </div>
          </fieldset>
        </ActionForm>
      </section>
      <p className="max-w-2xl text-sm text-ink-3">
        {t("View-through attribution (impressions) needs ad-network impression data, which LeanApp doesn't receive yet; the view lookback ({hours}h) is stored for when it does.", { hours: s.view_lookback_hours })}
      </p>
    </div>
  );
}
