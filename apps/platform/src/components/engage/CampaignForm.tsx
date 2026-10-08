"use client";

import { useState } from "react";
import { ActionForm, type FormState } from "@/components/ActionForm";
import { CHANNEL_LABELS, CHANNELS, type CampaignForm as Values, type Channel, type ScheduleMode } from "@/modules/campaigns/options";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <label className="block max-w-md"><span className="label">Campaign name</span><input name="name" className="input" required minLength={2} maxLength={80} defaultValue={name} /></label>

      <fieldset className="space-y-2">
        <legend className="h2">1. Audience</legend>
        {audiences.length === 0 ? (
          <p className="text-sm text-warn">This environment has no audiences. Create one in Audiences first.</p>
        ) : (
          <select name="audienceId" className="input max-w-md" required defaultValue={v("audienceId")} aria-label="Audience">
            <option value="" disabled>Choose an audience</option>
            {audiences.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.status === "active" ? `${a.member_count.toLocaleString("en-US")} people` : "draft: activate it before sending"})</option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="h2">2. Channel</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {CHANNELS.map((c) => (
            <label key={c} className="flex items-center gap-2"><input type="radio" name="channel" value={c} checked={channel === c} onChange={() => setChannel(c)} /> {CHANNEL_LABELS[c]}</label>
          ))}
        </div>
      </fieldset>

      <fieldset className="max-w-2xl space-y-3">
        <legend className="h2">3. Message</legend>
        {(channel === "push" || channel === "in_app") && (
          <>
            <label className="block"><span className="label">Title</span><input name="title" className="input" required maxLength={120} defaultValue={v("title")} /></label>
            <label className="block"><span className="label">Message</span><textarea name="body" className="input min-h-24" required maxLength={channel === "push" ? 500 : 1000} defaultValue={v("body")} /></label>
            {channel === "in_app" && <label className="block"><span className="label">Button text (optional)</span><input name="buttonText" className="input" maxLength={40} defaultValue={v("buttonText")} /></label>}
            <label className="block"><span className="label">Deep link (optional)</span><input name="deepLink" className="input" maxLength={500} placeholder="myapp://offers" defaultValue={v("deepLink")} /></label>
          </>
        )}
        {channel === "email" && (
          <>
            <label className="block"><span className="label">Template</span>
              <select name="emailTemplateId" className="input" value={emailTemplate} onChange={(e) => setEmailTemplate(e.target.value)}>
                <option value="">Write the email here</option>
                {emailTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            {!emailTemplate && (
              <>
                <label className="block"><span className="label">Subject</span><input name="subject" className="input" required maxLength={200} defaultValue={v("subject")} /></label>
                <label className="block"><span className="label">Text</span><textarea name="body" className="input min-h-32" required maxLength={20000} defaultValue={v("body")} /></label>
              </>
            )}
            <p className="text-xs text-ink-3">Sent to the person&apos;s <code>email</code> user property, with an unsubscribe link.</p>
          </>
        )}
        {channel === "whatsapp" && (
          whatsappTemplates.length === 0 ? (
            <p className="text-sm text-warn">No WhatsApp templates without a header variable are synced in this environment. Sync them on the WhatsApp integration.</p>
          ) : (
            <>
              <label className="block"><span className="label">Approved template</span>
                <select name="whatsappTemplate" className="input" required defaultValue={v("whatsappTemplate")}>
                  {whatsappTemplates.map((t) => (
                    <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>{t.name} ({t.language}, {t.body_params} variables{t.status === "APPROVED" ? "" : `, ${t.status.toLowerCase()}`})</option>
                  ))}
                </select>
              </label>
              <label className="block"><span className="label">Variables, one per line ({"{{user.first_name}}"} works)</span><textarea name="whatsappParams" className="input min-h-20" defaultValue={v("whatsappParams")} /></label>
              <label className="block max-w-xs"><span className="label">Phone number property</span><input name="phoneProperty" className="input" defaultValue={v("phoneProperty") || "phone"} maxLength={64} /></label>
            </>
          )
        )}
        <p className="text-xs text-ink-3">Use {"{{user.property}}"} to personalise.</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="h2">4. Schedule</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {([["now", "Send now"], ["later", "At a date and time"], ["daily", "Every day"], ["weekly", "Every week"]] as const).map(([m, label]) => (
            <label key={m} className="flex items-center gap-2"><input type="radio" name="schedule" value={m} checked={schedule === m} onChange={() => setSchedule(m)} /> {label}</label>
          ))}
        </div>
        {schedule === "later" && <label className="block max-w-xs"><span className="label">Send at ({timezone})</span><input type="datetime-local" name="sendAt" className="input" required defaultValue={v("sendAt")} /></label>}
        {(schedule === "daily" || schedule === "weekly") && (
          <div className="flex flex-wrap gap-3">
            {schedule === "weekly" && (
              <label className="block"><span className="label">Day</span><select name="weekday" className="input" defaultValue={v("weekday") || "0"}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
            )}
            <label className="block"><span className="label">Time ({timezone})</span><input type="time" name="time" className="input" required defaultValue={v("time") || "10:00"} /></label>
          </div>
        )}
        <p className="text-xs text-ink-3">The campaign is saved as a draft. It sends when you press Send on its page. Recurring sends reach everyone in the audience each time.</p>
      </fieldset>

      <fieldset className="space-y-2 text-sm">
        <legend className="h2">Limits</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={cap} onChange={(e) => setCap(e.target.checked)} /> Frequency cap: skip people who already got</label>
        {cap && (
          <div className="flex flex-wrap items-center gap-2 ps-6">
            <input name="capMessages" type="number" min={1} max={100} className="input w-20" defaultValue={v("capMessages") || "3"} aria-label="Messages" /> messages in the last
            <input name="capHours" type="number" min={1} max={720} className="input w-20" defaultValue={v("capHours") || "24"} aria-label="Hours" /> hours (from any campaign or flow)
          </div>
        )}
        <label className="flex items-center gap-2"><input type="checkbox" name="quietHours" value="on" defaultChecked={initial.channel ? initial.quietHours === "on" : true} /> Wait out quiet hours (22:00 to 08:00, {timezone}) for push, email and WhatsApp</label>
      </fieldset>
    </ActionForm>
  );
}
