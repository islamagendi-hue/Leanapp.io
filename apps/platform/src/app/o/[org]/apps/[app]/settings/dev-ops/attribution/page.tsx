import { updateSettingsAction } from "@/app/actions/attribution";
import { ActionForm } from "@/components/ActionForm";
import { can } from "@/modules/rbac/authorize";
import { getSettings } from "@/modules/attribution/service";
import { WINDOW_FORM_CHANNELS } from "@/modules/attribution/pure-credit";
import { channelInfo } from "@/modules/channels/registry";
import { ChannelRulesSettings } from "@/components/acquisition/ChannelRulesSettings";
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
              <span className="help">{t("An install matches a click (link click id, store referrer or ad-network click id) up to this long after it. Default 7.")} {t("Channels with their own window below use that one instead.")}</span>
            </label>
            <label className="block"><span className="label">{t("Conversion window (days)")}</span>
              <input name="conversionWindowDays" type="number" min={1} max={730} defaultValue={s.conversion_window_days} className="input w-32" />
              <span className="help">{t("Conversions this long after the install, re-engagement or web touch are credited to its source. Default 90.")}</span>
            </label>
            <label className="block"><span className="label">{t("Reports open with")}</span>
              <select name="reportingModel" className="input w-48" defaultValue={s.reporting_model}>
                <option value="last_touch">{t("Last touch")}</option>
                <option value="first_touch">{t("First touch")}</option>
                <option value="last_non_direct">{t("Last non-direct touch")}</option>
              </select>
              <span className="help">{t("Every model is always available on Sources & campaigns; this is the one it shows first. First touch is the person's earliest install, re-engagement or web touch within the conversion window. Last non-direct touch is the latest one with a known source: a later direct, organic or unattributed visit or install never takes the credit away from it.")}</span>
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
                    {rich(t("When no click id or campaign parameters match, credit an Android install to an unclaimed link click from the same network address (keyed hash, never the raw IP) and Android version within the window below and the click lookback. Reported separately as {probabilistic}. Never used on iOS. Off by default: turn it on only if your privacy notice discloses it."), {
                      probabilistic: <em>{t("probabilistic")}</em>,
                    })}
                  </span>
                </span>
              </label>
              <label className="block ps-6"><span className="label">{t("Window (hours)")}</span>
                <input name="probabilisticWindowHours" type="number" min={1} max={168} defaultValue={s.probabilistic_window_hours} className="input w-32" />
              </label>
            </div>
            <div className="space-y-2 rounded-lg border border-line p-4">
              <input type="hidden" name="windowOverridesPresent" value="1" />
              <p className="font-medium">{t("Windows per channel")}</p>
              <p className="help">{t("Leave a field blank to use the windows above. Ad networks count conversions in their own reports with their own windows, which LeanApp doesn't change or read; these windows only decide LeanApp's own credit.")}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-ink-3">
                      <th className="py-1 pe-3 text-start font-normal">{t("Channel")}</th>
                      <th className="py-1 pe-3 text-start font-normal">{t("Click lookback (days)")}</th>
                      <th className="py-1 text-start font-normal">{t("Conversion window (days)")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {WINDOW_FORM_CHANNELS.map((key) => (
                      <tr key={key} className="border-t border-line">
                        <td className="py-1 pe-3">{t(channelInfo(key).label)}</td>
                        <td className="py-1 pe-3">
                          <input name={`override.${key}.click`} type="number" min={1} max={90} aria-label={t("Click lookback for {channel} (days)", { channel: t(channelInfo(key).label) })}
                            defaultValue={s.window_overrides[key]?.click_lookback_days ?? ""} placeholder={String(s.click_lookback_days)} className="input w-24" />
                        </td>
                        <td className="py-1">
                          <input name={`override.${key}.conversion`} type="number" min={1} max={730} aria-label={t("Conversion window for {channel} (days)", { channel: t(channelInfo(key).label) })}
                            defaultValue={s.window_overrides[key]?.conversion_window_days ?? ""} placeholder={String(s.conversion_window_days)} className="input w-24" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </fieldset>
        </ActionForm>
      </section>
      <p className="max-w-2xl text-sm text-ink-3">
        {t("View-through (impression) attribution isn't built: it needs ad-network impression data, which LeanApp doesn't receive. The stored view lookback ({hours}h) is not used yet and changes nothing.", { hours: s.view_lookback_hours })}
      </p>
      <ChannelRulesSettings ctx={ctx} org={org} app={app} appId={a.id} manage={manage} />
    </div>
  );
}
