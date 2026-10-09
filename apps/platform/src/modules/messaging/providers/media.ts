/**
 * Checking a media asset (from the media library) against what the provider
 * accepts on the channel. Pure: the asset's metadata comes from the media
 * library (src/modules/media, worker D); the rules from ./registry.ts.
 */
import { msg } from "@/i18n/translate";
import { fill } from "@/modules/automation/messages";
import { can, messagingProvider, type MediaKind, type MediaRule, type MessagingChannel } from "./registry";

export interface MediaAssetMeta {
  id: string;
  mime: string;
  size: number;
}

export type MediaCheck = { ok: true; rule: MediaRule } | { ok: false; reason: string };

/** The rule an asset falls under for the provider and channel, or why it can't be sent. `kind` narrows it (e.g. a template's IMAGE header). */
export function checkMedia(providerId: string, channel: MessagingChannel, asset: MediaAssetMeta, kind?: MediaKind): MediaCheck {
  const provider = messagingProvider(providerId);
  if (!provider) return { ok: false, reason: msg("Unknown provider.") };
  if (!can(providerId, "media")) return { ok: false, reason: fill(msg("{provider} media sending isn't available in LeanApp."), { provider: provider.name }) };
  const rules = provider.media.filter((r) => r.channel === channel && (!kind || r.kind === kind));
  if (!rules.length) return { ok: false, reason: fill(msg("{provider} doesn't accept media on this channel."), { provider: provider.name }) };
  const mime = asset.mime.toLowerCase().split(";")[0].trim();
  const rule = rules.find((r) => r.mimeTypes.includes(mime));
  if (!rule) return { ok: false, reason: fill(msg("{provider} doesn't accept {mime} here. Allowed: {allowed}."), { provider: provider.name, mime, allowed: rules.flatMap((r) => r.mimeTypes).join(", ") }) };
  if (asset.size > rule.maxBytes) return { ok: false, reason: fill(msg("The file is {size} MB; {provider} accepts at most {max} MB for {kind}."), { size: (asset.size / 1048576).toFixed(1), provider: provider.name, max: +(rule.maxBytes / 1048576).toFixed(1), kind: rule.kind }) };
  return { ok: true, rule };
}

/** WhatsApp template header formats that need a media parameter, and the media kind each takes. */
export const HEADER_MEDIA: Record<string, MediaKind> = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" };

/** SMS stays text: media goes only through a provider that declares MMS, and only to the numbers it allows (+1 for Twilio). */
export function mmsAllowed(providerId: string, e164: string): boolean {
  const rule = messagingProvider(providerId)?.media.find((r) => r.channel === "sms");
  if (!rule || !can(providerId, "media")) return false;
  return providerId === "twilio" ? e164.startsWith("+1") : false;
}
