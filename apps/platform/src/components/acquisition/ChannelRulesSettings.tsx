import { createChannelRuleAction, createCustomChannelAction, setChannelRuleStatusAction, setCustomChannelStatusAction } from "@/app/actions/channels";
import { ActionForm } from "@/components/ActionForm";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translate";
import type { RuleConditions } from "@/modules/channels/classify";
import { BUILT_IN_CHANNELS, channelInfo, CLICK_ID_CHANNELS, GROUP_LABELS } from "@/modules/channels/registry";
import { listChannelConfig } from "@/modules/channels/service";
import type { TenantContext } from "@/modules/tenancy/context";
import { statusName } from "./rich";

/**
 * Settings → Dev Ops → Attribution: the app's custom channels and channel
 * rules. Everyone with attribution.read sees them; the forms and buttons
 * only render for attribution.manage.
 */

function describe(c: RuleConditions, t: T): string {
  const parts: string[] = [];
  if (c.source?.length) parts.push(t("source is {v}", { v: c.source.join(", ") }));
  if (c.medium?.length) parts.push(t("medium is {v}", { v: c.medium.join(", ") }));
  if (c.campaignPrefix) parts.push(t("campaign starts with {v}", { v: c.campaignPrefix }));
  if (c.referrerHost) parts.push(t("referrer is {v}", { v: c.referrerHost }));
  if (c.clickIdParam) parts.push(t("has click id {v}", { v: c.clickIdParam }));
  if (c.hasReferralId) parts.push(t("has a referral id"));
  return parts.join(" · ");
}

export async function ChannelRulesSettings({ ctx, org, app, appId, manage }: { ctx: TenantContext; org: string; app: string; appId: string; manage: boolean }) {
  const t = await getT();
  const { channels, rules } = await listChannelConfig(ctx, appId);
  const active = channels.filter((c) => c.status === "active");
  const selectable = [
    ...BUILT_IN_CHANNELS.filter((c) => c.key !== "unattributed").map((c) => ({ key: c.key, label: t(c.label), group: c.group })),
    ...active.map((c) => ({ key: c.key, label: c.label, group: c.group })),
  ];
  const clickIds = Object.keys(CLICK_ID_CHANNELS).filter((k) => k !== "sccid");

  return (
    <section className="card space-y-5" data-testid="channel-rules">
      <div>
        <h2 className="h2">{t("Channels and rules")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-2">
          {t("LeanApp puts every click, install and conversion on a channel from its built-in registry: ad-network click ids, then source and medium, then the referring site. Your rules run first, in priority order, and apply to past data too. Direct, unknown and unattributed are never counted as organic.")}
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">{t("Custom channels")}</h3>
        {channels.length === 0 ? <p className="text-sm text-ink-3">{t("No custom channels yet. Add one for a channel the registry doesn't have, such as radio or a regional ad network.")}</p> : (
          <table className="table text-sm">
            <thead><tr><th>{t("Channel")}</th><th>{t("Key")}</th><th>{t("Group")}</th><th>{t("Status")}</th>{manage && <th />}</tr></thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}{c.description && <span className="block text-xs text-ink-3">{c.description}</span>}</td>
                  <td className="font-mono text-xs" dir="ltr">{c.key}</td>
                  <td>{t(GROUP_LABELS[c.group])}</td>
                  <td>{c.status === "active" ? statusName(t, "active") : t("archived")}</td>
                  {manage && (
                    <td><ActionForm action={setCustomChannelStatusAction.bind(null, org, app, c.id, c.status === "active" ? "archived" : "active")}
                      submitLabel={c.status === "active" ? t("Archive") : t("Restore")} buttonClass="btn-secondary min-h-8 px-3" className="" /></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {manage && (
          <ActionForm action={createCustomChannelAction.bind(null, org, app)} submitLabel={t("Add channel")} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <label className="block"><span className="label">{t("Name")}</span><input name="label" className="input" required maxLength={80} placeholder={t("Radio")} /></label>
            <label className="block"><span className="label">{t("Group")}</span>
              <select name="group" className="input" defaultValue="paid">
                {(["paid", "organic", "owned", "referral", "custom"] as const).map((g) => <option key={g} value={g}>{t(GROUP_LABELS[g])}</option>)}
              </select>
            </label>
            <label className="block"><span className="label">{t("Key (optional)")}</span><input name="key" className="input font-mono" maxLength={47} placeholder="custom_radio" dir="ltr" /></label>
            <label className="block"><span className="label">{t("Description (optional)")}</span><input name="description" className="input" maxLength={300} /></label>
          </ActionForm>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">{t("Rules")}</h3>
        {rules.length === 0 ? <p className="text-sm text-ink-3">{t("No rules yet: the built-in registry decides every channel.")}</p> : (
          <table className="table text-sm">
            <thead><tr><th className="text-end">{t("Priority")}</th><th>{t("When")}</th><th>{t("Channel")}</th><th>{t("Status")}</th>{manage && <th />}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="text-end tabular-nums">{r.priority}</td>
                  <td dir="auto">{describe(r.conditions, t)}{r.note && <span className="block text-xs text-ink-3">{r.note}</span>}</td>
                  <td>{(() => { const i = channelInfo(r.channel, channels); return i.builtIn ? t(i.label) : i.label; })()}</td>
                  <td>{statusName(t, r.status)}</td>
                  {manage && (
                    <td className="flex gap-2">
                      <ActionForm action={setChannelRuleStatusAction.bind(null, org, app, r.id, r.status === "active" ? "paused" : "active")} submitLabel={r.status === "active" ? t("Pause") : t("Resume")} buttonClass="btn-secondary min-h-8 px-3" className="" />
                      <ActionForm action={setChannelRuleStatusAction.bind(null, org, app, r.id, "deleted")} submitLabel={t("Delete")} buttonClass="btn-danger" className="" confirm={t("Delete this rule? Reports go back to the built-in channels for these touches.")} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {manage && (
          <ActionForm action={createChannelRuleAction.bind(null, org, app)} submitLabel={t("Add rule")} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block"><span className="label">{t("Put matching touches on")}</span>
                <select name="channel" className="input" required defaultValue="">
                  <option value="" disabled>{t("Choose a channel")}</option>
                  {(["paid", "organic", "owned", "referral", "custom", "none"] as const).map((g) => {
                    const opts = selectable.filter((c) => c.group === g);
                    return opts.length ? <optgroup key={g} label={t(GROUP_LABELS[g])}>{opts.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</optgroup> : null;
                  })}
                </select>
              </label>
              <label className="block"><span className="label">{t("Priority")}</span><input name="priority" type="number" min={1} max={1000} defaultValue={100} className="input w-32" />
                <span className="help">{t("Lower runs first.")}</span></label>
              <label className="block"><span className="label">{t("Note (optional)")}</span><input name="note" className="input" maxLength={200} /></label>
            </div>
            <p className="text-sm text-ink-3">{t("Conditions: fill at least one. Every condition you fill must hold.")}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block"><span className="label">{t("Source is")}</span><input name="source" className="input font-mono" maxLength={500} placeholder="radio_fm, sawt" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Medium is")}</span><input name="medium" className="input font-mono" maxLength={500} placeholder="audio" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Campaign starts with")}</span><input name="campaignPrefix" className="input font-mono" maxLength={100} placeholder="fm_" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Referrer host")}</span><input name="referrerHost" className="input font-mono" maxLength={200} placeholder="news.example.com" dir="ltr" /></label>
              <label className="block"><span className="label">{t("Has click id")}</span>
                <select name="clickIdParam" className="input" defaultValue="">
                  <option value="">{t("Any")}</option>
                  {clickIds.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 self-end"><input type="checkbox" name="hasReferralId" /> <span>{t("Has a referral or invite id")}</span></label>
            </div>
          </ActionForm>
        )}
      </div>
    </section>
  );
}
