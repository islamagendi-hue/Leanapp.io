"use client";

import { useState } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { MediaPicker } from "@/components/engage/MediaPicker";
import { CHANNEL_LABELS, CHANNELS, type CampaignForm as Values, type Channel, type ScheduleMode } from "@/modules/campaigns/options";

const WEEKDAYS = [msg("Sunday"), msg("Monday"), msg("Tuesday"), msg("Wednesday"), msg("Thursday"), msg("Friday"), msg("Saturday")];
const SCHEDULE_OPTIONS = [["now", msg("Send now")], ["later", msg("At a date and time")], ["daily", msg("Every day")], ["weekly", msg("Every week")]] as const;

/** Audience → Channel → Message → Schedule, plus the frequency cap and quiet hours. */
export function CampaignForm({ action, name, initial, audiences, emailTemplates, whatsappTemplates, timezone, submitLabel }: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  name: string;
  initial: Values;
  audiences: { id: string; name: string; status: string; member_count: number }[];
  emailTemplates: { id: string; name: string }[];
  whatsappTemplates: { name: string; language: string; status: string; body_params: number }[];
  timezone: string;
  submitLabel: string;
}) {
  const [channel, setChannel] = useState<Channel>((initial.channel as Channel) ?? "push");
  const [schedule, setSchedule] = useState<ScheduleMode>((initial.schedule as ScheduleMode) ?? "now");
  const [emailTemplate, setEmailTemplate] = useState(initial.emailTemplateId ?? "");
  const [cap, setCap] = useState(Boolean(initial.capMessages) || !initial.channel);
  const v = (k: keyof Values) => initial[k] ?? "";
  const t = useT();

  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <label className="block max-w-md"><span className="label">{t("Campaign name")}</span><input name="name" className="input" required minLength={2} maxLength={80} defaultValue={name} /></label>

      <fieldset className="space-y-2">
        <legend className="h2">{t("1. Audience")}</legend>
        {audiences.length === 0 ? (
          <p className="text-sm text-warn">{t("This environment has no audiences. Create one in Audiences first.")}</p>
        ) : (
          <select name="audienceId" className="input max-w-md" required defaultValue={v("audienceId")} aria-label={t("Audience")}>
            <option value="" disabled>{t("Choose an audience")}</option>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>{a.status === "active" ? t("{name} ({n} people)", { name: a.name, n: a.member_count.toLocaleString("en-US") }) : t("{name} (draft: activate it before sending)", { name: a.name })}</option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="h2">{t("2. Channel")}</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {CHANNELS.map((c) => (
            <label key={c} className="flex items-center gap-2"><input type="radio" name="channel" value={c} checked={channel === c} onChange={() => setChannel(c)} /> {t(CHANNEL_LABELS[c])}</label>
          ))}
        </div>
      </fieldset>

      <fieldset className="max-w-2xl space-y-3">
        <legend className="h2">{t("3. Message")}</legend>
        {(channel === "push" || channel === "in_app") && (
          <>
            <label className="block"><span className="label">{t("Title")}</span><input name="title" className="input" required maxLength={120} defaultValue={v("title")} /></label>
            <label className="block"><span className="label">{t("Message")}</span><textarea name="body" className="input min-h-24" required maxLength={channel === "push" ? 500 : 1000} defaultValue={v("body")} /></label>
            {channel === "in_app" && <label className="block"><span className="label">{t("Button text (optional)")}</span><input name="buttonText" className="input" maxLength={40} defaultValue={v("buttonText")} /></label>}
            <label className="block"><span className="label">{t("Deep link (optional)")}</span><input name="deepLink" className="input" maxLength={500} placeholder="myapp://offers" dir="ltr" defaultValue={v("deepLink")} /></label>
            <MediaPicker key={channel} name="imageAssetId" channel={channel} defaultValue={v("imageAssetId")} />
          </>
        )}
        {channel === "email" && (
          <>
            <label className="block"><span className="label">{t("Template")}</span>
              <select name="emailTemplateId" className="input" value={emailTemplate} onChange={(e) => setEmailTemplate(e.target.value)}>
                <option value="">{t("Write the email here")}</option>
                {emailTemplates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
            {!emailTemplate && (
              <>
                <label className="block"><span className="label">{t("Subject")}</span><input name="subject" className="input" required maxLength={200} defaultValue={v("subject")} /></label>
                <label className="block"><span className="label">{t("Text")}</span><textarea name="body" className="input min-h-32" required maxLength={20000} defaultValue={v("body")} /></label>
              </>
            )}
            <p className="text-xs text-ink-3">{t("Sent to the person's {email} user property, with an unsubscribe link.", { email: "email" })}</p>
          </>
        )}
        {channel === "whatsapp" && (
          whatsappTemplates.length === 0 ? (
            <p className="text-sm text-warn">{t("No WhatsApp templates without a header variable are synced in this environment. Sync them on the WhatsApp integration.")}</p>
          ) : (
            <>
              <label className="block"><span className="label">{t("Approved template")}</span>
                <select name="whatsappTemplate" className="input" required defaultValue={v("whatsappTemplate")}>
                  {whatsappTemplates.map((w) => (
                    <option key={`${w.name}|${w.language}`} value={`${w.name}|${w.language}`}>{w.status === "APPROVED"
                      ? t("{name} ({language}, {n} variables)", { name: w.name, language: w.language, n: w.body_params })
                      : t("{name} ({language}, {n} variables, {status})", { name: w.name, language: w.language, n: w.body_params, status: w.status.toLowerCase() })}</option>
                  ))}
                </select>
              </label>
              <label className="block"><span className="label">{t("Variables, one per line ({example} works)", { example: "{{user.first_name}}" })}</span><textarea name="whatsappParams" className="input min-h-20" defaultValue={v("whatsappParams")} /></label>
              <label className="block max-w-xs"><span className="label">{t("Phone number property")}</span><input name="phoneProperty" className="input" defaultValue={v("phoneProperty") || "phone"} maxLength={64} /></label>
            </>
          )
        )}
        <p className="text-xs text-ink-3">{t("Use {example} to personalise.", { example: "{{user.property}}" })}</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="h2">{t("4. Schedule")}</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {SCHEDULE_OPTIONS.map(([m, label]) => (
            <label key={m} className="flex items-center gap-2"><input type="radio" name="schedule" value={m} checked={schedule === m} onChange={() => setSchedule(m)} /> {t(label)}</label>
          ))}
        </div>
        {schedule === "later" && <label className="block max-w-xs"><span className="label">{t("Send at ({timezone})", { timezone })}</span><input type="datetime-local" name="sendAt" className="input" required defaultValue={v("sendAt")} /></label>}
        {(schedule === "daily" || schedule === "weekly") && (
          <div className="flex flex-wrap gap-3">
            {schedule === "weekly" && (
              <label className="block"><span className="label">{t("Day")}</span><select name="weekday" className="input" defaultValue={v("weekday") || "0"}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{t(d)}</option>)}</select></label>
            )}
            <label className="block"><span className="label">{t("Time ({timezone})", { timezone })}</span><input type="time" name="time" className="input" required defaultValue={v("time") || "10:00"} /></label>
          </div>
        )}
        <p className="text-xs text-ink-3">{t("The campaign is saved as a draft. It sends when you press Send on its page. Recurring sends reach everyone in the audience each time.")}</p>
      </fieldset>

      <fieldset className="space-y-2 text-sm">
        <legend className="h2">{t("Limits")}</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={cap} onChange={(e) => setCap(e.target.checked)} /> {t("Frequency cap: skip people who already got")}</label>
        {cap && (
          <div className="flex flex-wrap items-center gap-2 ps-6">
            <input name="capMessages" type="number" min={1} max={100} className="input w-20" defaultValue={v("capMessages") || "3"} aria-label={t("Messages")} /> {t("messages in the last")}
            <input name="capHours" type="number" min={1} max={720} className="input w-20" defaultValue={v("capHours") || "24"} aria-label={t("Hours")} /> {t("hours (from any campaign or flow)")}
          </div>
        )}
        <label className="flex items-center gap-2"><input type="checkbox" name="quietHours" value="on" defaultChecked={initial.channel ? initial.quietHours === "on" : true} /> {t("Wait out quiet hours (22:00 to 08:00, {timezone}) for push, email and WhatsApp", { timezone })}</label>
      </fieldset>
    </ActionForm>
  );
}
