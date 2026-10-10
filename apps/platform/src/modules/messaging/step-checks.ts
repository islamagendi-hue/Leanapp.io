import "server-only";
import type { Db } from "@/lib/db";
import { msg } from "@/i18n/translate";
import type { Step } from "@/modules/automation/definition";
import { fill } from "@/modules/automation/messages";
import { resolveMedia } from "./media";
import { checkMedia, HEADER_MEDIA } from "./providers/media";
import { messagingProvider, PROVIDER_OF_INTEGRATION } from "./providers/registry";

/**
 * Checks of a WhatsApp or SMS step against what is connected and synced in
 * the environment, shared by flow/campaign saving and activation and the
 * composer's validation panel:
 *   - the provider is connected in the environment;
 *   - the template is synced for that provider, has the variables the step
 *     fills, and (on activation) is approved;
 *   - a media header gets a media file, and media goes only where the
 *     provider declares it, with the provider's type and size limits.
 * `requireActive`: activation (approval and media must be ready), not a draft save.
 */
export interface StepIssue {
  level: "error" | "warning";
  message: string;
}

type MessagingStep = Extract<Step, { type: "whatsapp" | "whatsapp_session" | "sms" }>;

export async function checkMessagingStep(
  db: Db,
  ref: { organizationId: string; appId: string; environmentId: string },
  s: MessagingStep,
  opts: { requireActive: boolean },
): Promise<StepIssue[]> {
  const issues: StepIssue[] = [];
  const error = (message: string) => issues.push({ level: "error", message });
  const setup = (message: string) => issues.push({ level: opts.requireActive ? "error" : "warning", message });
  const provider = messagingProvider(s.provider)!;
  const integration = Object.entries(PROVIDER_OF_INTEGRATION).find(([, p]) => p === s.provider)?.[0];
  const connected = await db.one<{ status: string; config: Record<string, string> }>(
    "select status, config from platform.integrations where environment_id = $1 and provider = $2",
    [ref.environmentId, integration],
  );
  if (!connected) setup(fill(msg("{provider} isn't connected in this environment."), { provider: provider.name }));
  else if (s.provider === "twilio") {
    if ((s.type === "whatsapp" || s.type === "whatsapp_session") && !connected.config.whatsapp_from) setup(msg("The Twilio integration has no WhatsApp sender."));
    if (s.type === "sms" && !connected.config.messaging_service_sid && !connected.config.from_number) setup(msg("The Twilio integration has no SMS sender."));
  }

  let mediaKind: "image" | "video" | "document" | undefined;
  let whatsappHeader: string | null = null;
  if (s.type === "whatsapp") {
    const t = await db.one<{ status: string; body_params: number; header_params: number; header_format: string | null }>(
      "select status, body_params, header_params, header_format from platform.whatsapp_templates where environment_id = $1 and provider = $2 and name = $3 and language = $4",
      [ref.environmentId, s.provider, s.template, s.language],
    );
    if (!t) {
      error(fill(msg('The WhatsApp template "{template}" ({language}) isn\'t synced in this environment. Sync templates on Engage → Integrations.'), { template: s.template, language: s.language }));
      return issues;
    }
    if (t.body_params !== s.bodyParams.length || t.header_params !== s.headerParams.length) {
      error(fill(msg('The WhatsApp template "{template}" needs {body} body and {header} header variables.'), { template: s.template, body: t.body_params, header: t.header_params }));
    }
    if (opts.requireActive && t.status !== "APPROVED") error(fill(msg('The WhatsApp template "{template}" is {status}, not approved by WhatsApp yet.'), { template: s.template, status: t.status.toLowerCase() }));
    whatsappHeader = t.header_format;
    mediaKind = t.header_format ? (HEADER_MEDIA[t.header_format] as typeof mediaKind) : undefined;
    if (mediaKind && !s.mediaAssetId) error(fill(msg('The WhatsApp template "{template}" has a media header ({kind}): choose a media file.'), { template: s.template, kind: t.header_format ?? "" }));
    if (!mediaKind && s.mediaAssetId) error(fill(msg('The WhatsApp template "{template}" has no media header, so it can\'t carry a file.'), { template: s.template }));
  }
  if (s.mediaAssetId && s.type === "sms" && !provider.media.some((m) => m.channel === "sms")) {
    error(fill(msg("{provider} doesn't send media by SMS."), { provider: provider.name }));
  }
  if (s.mediaAssetId && !issues.some((i) => i.level === "error")) {
    const channel = s.type === "sms" ? "sms" : "whatsapp";
    const r = await resolveMedia(db, { organizationId: ref.organizationId, appId: ref.appId, assetId: s.mediaAssetId, channel, provider: s.provider, whatsappHeader });
    if (!r.available) {
      if (opts.requireActive) error(r.reason);
      else issues.push({ level: "warning", message: r.reason });
    } else {
      const c = checkMedia(s.provider, channel, { id: s.mediaAssetId, mime: r.media.mime, size: r.media.size }, mediaKind);
      if (!c.ok) error(c.reason);
    }
  }
  if (s.type === "sms" && s.mediaAssetId) issues.push({ level: "warning", message: msg("MMS goes only to US and Canadian numbers; other recipients are skipped with a reason.") });
  return issues;
}
