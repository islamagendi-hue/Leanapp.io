"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import type { FormState } from "@/components/ActionForm";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { HEADER_MEDIA } from "@/modules/messaging/providers/media";
import { messagingProvider } from "@/modules/messaging/providers/registry";
import { fromParam, missingVariables, previewTemplate, smsSegments, toParam, type VariableSource } from "@/modules/messaging/variables";

/**
 * The WhatsApp and SMS parts of the campaign composer: provider choice among
 * the connected ones, template discovery (search and filters over synced
 * templates, with their real status), variable mapping to user attributes or
 * fixed text, a preview, the media field for media headers / MMS, plus the
 * Check and Test buttons that run the server's validation and the real send
 * path. Values travel in the campaign form's fields (whatsappTemplate,
 * whatsappParams, whatsappHeaderParams, whatsappProvider, mediaAssetId).
 */

export interface ComposerTemplate {
  id: string;
  provider: "whatsapp_cloud" | "twilio";
  name: string;
  language: string;
  category: string | null;
  status: string;
  rejected_reason: string | null;
  header_format: string | null;
  header_params: number;
  body_params: number;
  variables: string[];
  body_text: string | null;
  header_text: string | null;
  footer_text: string | null;
}

const PROVIDER_LABEL: Record<string, string> = { whatsapp_cloud: "Meta", twilio: "Twilio" };
const SOURCES = [["user", msg("User attribute")], ["text", msg("Fixed text")]] as const;

function lines(v: string | undefined): string[] {
  return (v ?? "").split("\n").map((l) => l.trim());
}

/**
 * Media library integration point: the field carries one asset id. The media
 * library's picker (worker D) replaces the text input with
 * <MediaPicker name="mediaAssetId" kinds={…} />; the server validates the
 * asset against the provider's declared media types and size limits.
 */
export function MediaField({ name = "mediaAssetId", value, kind, providerId, channel }: { name?: string; value?: string; kind: string; providerId: string; channel: "whatsapp" | "sms" }) {
  const t = useT();
  const rules = messagingProvider(providerId)?.media.filter((r) => r.channel === channel && (!HEADER_MEDIA[kind.toUpperCase()] || r.kind === kind)) ?? [];
  return (
    <label className="block">
      <span className="label">{t("Media file ({kind})", { kind })}</span>
      <input name={name} className="input font-mono" defaultValue={value} placeholder={t("Media library asset ID")} dir="ltr" pattern="[0-9a-fA-F-]{36}" />
      <span className="help">{rules.length ? t("Accepted: {types}, up to {mb} MB.", { types: rules.flatMap((r) => r.mimeTypes).join(", "), mb: Math.max(...rules.map((r) => r.maxBytes)) / 1048576 }) : t("This provider doesn't accept media here.")}</span>
    </label>
  );
}

function VariableRow({ label, value, onChange, properties }: { label: string; value: string; onChange: (v: string) => void; properties: string[] }) {
  const t = useT();
  const src = fromParam(value);
  const set = (s: VariableSource) => onChange(toParam(s));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="w-24 font-mono text-xs">{label}</code>
      <select className="input w-40" value={src.kind === "event" ? "user" : src.kind} onChange={(e) => set({ kind: e.target.value as VariableSource["kind"], value: "" })} aria-label={t("Source")}>
        {SOURCES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
      </select>
      {src.kind === "text"
        ? <input className="input min-w-48 flex-1" value={src.value} onChange={(e) => set({ kind: "text", value: e.target.value })} aria-label={t("Value")} dir="auto" />
        : (
          <select className="input min-w-48 flex-1" value={src.value} onChange={(e) => set({ kind: "user", value: e.target.value })} aria-label={t("User attribute")}>
            <option value="">{t("Choose an attribute")}</option>
            {[...new Set([...properties, ...(src.value ? [src.value] : [])])].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
    </div>
  );
}

export function WhatsAppComposer({ templates, providers, initial, properties }: {
  templates: ComposerTemplate[];
  /** Connected WhatsApp providers in this environment. */
  providers: ("whatsapp_cloud" | "twilio")[];
  initial: { whatsappTemplate?: string; whatsappParams?: string; whatsappHeaderParams?: string; whatsappProvider?: string; mediaAssetId?: string; phoneProperty?: string };
  properties: string[];
}) {
  const t = useT();
  const [provider, setProvider] = useState<string>(initial.whatsappProvider ?? providers[0] ?? "whatsapp_cloud");
  const [q, setQ] = useState("");
  const [language, setLanguage] = useState("");
  const [onlyApproved, setOnlyApproved] = useState(true);
  const [key, setKey] = useState(initial.whatsappTemplate ?? "");
  const [header, setHeader] = useState<string[]>(lines(initial.whatsappHeaderParams));
  const [body, setBody] = useState<string[]>(lines(initial.whatsappParams));

  const ofProvider = templates.filter((x) => x.provider === provider);
  const languages = [...new Set(ofProvider.map((x) => x.language))].sort();
  const shown = ofProvider.filter((x) => (!onlyApproved || x.status === "APPROVED") && (!language || x.language === language)
    && (!q || x.name.includes(q.toLowerCase()) || (x.body_text ?? "").toLowerCase().includes(q.toLowerCase())));
  const tpl = ofProvider.find((x) => `${x.name}|${x.language}` === key) ?? null;
  const headerKeys = tpl ? tpl.variables.slice(0, tpl.header_params) : [];
  const bodyKeys = tpl ? tpl.variables.slice(tpl.header_params) : [];
  const hp = headerKeys.map((_, i) => header[i] ?? "");
  const bp = bodyKeys.map((_, i) => body[i] ?? "");
  const missing = tpl ? [...missingVariables(headerKeys, hp), ...missingVariables(bodyKeys, bp).map((n) => n + headerKeys.length)] : [];
  const mediaKind = tpl?.header_format ? HEADER_MEDIA[tpl.header_format] : undefined;

  if (!providers.length) return <p className="text-sm text-warn">{t("No WhatsApp provider is connected in this environment. Connect Meta's WhatsApp Cloud API or Twilio in Settings → Dev Ops → Channels.")}</p>;
  return (
    <div className="space-y-3">
      <input type="hidden" name="whatsappProvider" value={provider} />
      <input type="hidden" name="whatsappTemplate" value={key} />
      <input type="hidden" name="whatsappHeaderParams" value={hp.join("\n")} />
      <input type="hidden" name="whatsappParams" value={bp.join("\n")} />
      {providers.length > 1 && (
        <div className="flex flex-wrap gap-3 text-sm" role="radiogroup" aria-label={t("Provider")}>
          {providers.map((p) => <label key={p} className="flex items-center gap-2"><input type="radio" checked={provider === p} onChange={() => { setProvider(p); setKey(""); }} /> {messagingProvider(p)?.name}</label>)}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="label">{t("Search templates")}</span><input className="input" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <label className="block"><span className="label">{t("Language")}</span>
          <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">{t("All")}</option>{languages.map((l) => <option key={l} value={l}>{l}</option>)}</select>
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} /> {t("Approved only")}</label>
      </div>
      {ofProvider.length === 0 ? (
        <p className="text-sm text-warn">{t("No templates are synced from {provider}. Sync them on Engage → WhatsApp templates.", { provider: PROVIDER_LABEL[provider] })}</p>
      ) : (
        <label className="block"><span className="label">{t("Template")}</span>
          <select className="input" value={key} onChange={(e) => { setKey(e.target.value); setHeader([]); setBody([]); }} required>
            <option value="">{t("Choose a template")}</option>
            {tpl && !shown.includes(tpl) && <option value={key}>{tpl.name} ({tpl.language}) · {tpl.status.toLowerCase()}</option>}
            {shown.map((x) => (
              <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>
                {x.name} ({x.language}) · {(x.category ?? "").toLowerCase()} · {x.status.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      )}
      {tpl && (
        <>
          <p className={`text-sm ${tpl.status === "APPROVED" ? "text-accent-ink" : "text-alert"}`}>
            {tpl.status === "APPROVED" ? t("Approved by WhatsApp.") : t("Status: {status}. Only approved templates can be sent.", { status: tpl.status.toLowerCase() })}
            {tpl.rejected_reason ? ` ${t("reason: {reason}", { reason: tpl.rejected_reason.toLowerCase().replace(/_/g, " ") })}` : ""}
          </p>
          {(headerKeys.length > 0 || bodyKeys.length > 0) && (
            <fieldset className="space-y-2">
              <legend className="label">{t("Variables (all required)")}</legend>
              {headerKeys.map((k, i) => <VariableRow key={`h${k}`} label={t("header {v}", { v: `{{${k}}}` })} value={hp[i]} properties={properties} onChange={(v) => setHeader(hp.map((x, j) => (j === i ? v : x)))} />)}
              {bodyKeys.map((k, i) => <VariableRow key={`b${k}`} label={`{{${k}}}`} value={bp[i]} properties={properties} onChange={(v) => setBody(bp.map((x, j) => (j === i ? v : x)))} />)}
              {missing.length > 0 && <p className="text-xs text-alert">{t("Fill in variable {list}.", { list: missing.join(", ") })}</p>}
            </fieldset>
          )}
          {mediaKind && <MediaField kind={mediaKind} value={initial.mediaAssetId} providerId={provider} channel="whatsapp" />}
          <Preview header={tpl.header_text ? previewTemplate(tpl.header_text, headerKeys, hp) : null} body={previewTemplate(tpl.body_text ?? "", bodyKeys, bp)} footer={tpl.footer_text} media={mediaKind} />
        </>
      )}
      <label className="block max-w-xs"><span className="label">{t("Phone number property")}</span><input name="phoneProperty" className="input" defaultValue={initial.phoneProperty || "phone"} maxLength={64} /></label>
    </div>
  );
}

function Preview({ header, body, footer, media }: { header: string | null; body: string; footer: string | null; media?: string }) {
  const t = useT();
  return (
    <div className="max-w-md space-y-1 rounded-lg bg-paper-2 p-3 text-sm" dir="auto" aria-label={t("Preview")}>
      <p className="text-xs text-ink-3">{t("Preview (attributes shown as references; each person gets their own values)")}</p>
      {media && <p className="text-xs text-ink-3">[{media}]</p>}
      {header && <p className="font-medium">{header}</p>}
      <p className="whitespace-pre-wrap">{body}</p>
      {footer && <p className="text-xs text-ink-3">{footer}</p>}
    </div>
  );
}

export function SmsComposer({ connected, initial }: { connected: boolean; initial: { body?: string; mediaAssetId?: string; phoneProperty?: string } }) {
  const t = useT();
  const [text, setText] = useState(initial.body ?? "");
  const seg = useMemo(() => smsSegments(text), [text]);
  const [mms, setMms] = useState(Boolean(initial.mediaAssetId));
  return (
    <div className="space-y-3">
      {!connected && <p className="text-sm text-warn">{t("SMS needs Twilio, which isn't connected in this environment (Settings → Dev Ops → Channels).")}</p>}
      <label className="block"><span className="label">{t("Message")}</span><textarea name="body" className="input min-h-24" required maxLength={1600} value={text} onChange={(e) => setText(e.target.value)} dir="auto" /></label>
      <p className="text-xs text-ink-3">{t("{n} characters · {segments} SMS part(s) · {encoding}", { n: seg.characters, segments: seg.segments, encoding: seg.encoding })}</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mms} onChange={(e) => setMms(e.target.checked)} /> {t("Add an image (MMS: US and Canadian numbers only)")}</label>
      {mms && <MediaField kind="image" value={initial.mediaAssetId} providerId="twilio" channel="sms" />}
      <label className="block max-w-xs"><span className="label">{t("Phone number property")}</span><input name="phoneProperty" className="input" defaultValue={initial.phoneProperty || "phone"} maxLength={64} /></label>
    </div>
  );
}

type Check = { issues: { level: "error" | "warning"; message: string }[]; reach: { members: number; excluded: number } | null; error?: string };

/** Check (server validation against providers, approval, consent) and a test send through the real send path. */
export function ComposerChecks({ check, test, testable }: {
  check: (form: FormData) => Promise<Check>;
  test: (state: FormState, form: FormData) => Promise<FormState>;
  testable: boolean;
}) {
  const t = useT();
  const [result, setResult] = useState<Check | null>(null);
  const [pending, start] = useTransition();
  const [testState, runTest, testing] = useActionState(test, {});
  const formOf = (el: HTMLButtonElement) => new FormData(el.form ?? undefined);
  return (
    <fieldset className="space-y-3">
      <legend className="h2">{t("Check and test")}</legend>
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" className="btn-secondary" disabled={pending} onClick={(e) => { const fd = formOf(e.currentTarget); start(async () => setResult(await check(fd))); }}>
          {pending ? t("Checking…") : t("Check campaign")}
        </button>
        {testable && (
          <>
            <label className="block"><span className="label">{t("Test recipient (user ID)")}</span><input name="testUserId" className="input" maxLength={200} /></label>
            <button type="button" className="btn-secondary" disabled={testing} onClick={(e) => { const fd = formOf(e.currentTarget); start(() => runTest(fd)); }}>
              {testing ? t("Sending…") : t("Send test")}
            </button>
          </>
        )}
      </div>
      {result && (
        <div className="space-y-1 text-sm" role="status">
          {result.error && <p className="text-alert">{t(result.error)}</p>}
          {!result.error && result.issues.length === 0 && <p className="text-accent-ink">{t("No problems found: the provider is connected and the message can be sent.")}</p>}
          {result.issues.map((i, n) => <p key={n} className={i.level === "error" ? "text-alert" : "text-warn"}>{i.level === "error" ? t("Blocks sending:") : t("Note:")} {i.message}</p>)}
          {result.reach && <p className="text-ink-2">{t("{members} people in the audience; {excluded} are excluded by consent or suppression on this channel.", { members: result.reach.members, excluded: result.reach.excluded })}</p>}
        </div>
      )}
      {testState.error && <p className="text-sm text-alert" role="alert">{t(testState.error)}</p>}
      {testState.ok && testState.message && <p className="text-sm text-accent-ink" role="status">{t(testState.message)}</p>}
      {testable && <p className="help">{t("The test goes to one person through the same path as the campaign (consent, approval, provider). Quiet hours and the frequency cap don't apply. At most 20 tests an hour.")}</p>}
    </fieldset>
  );
}
