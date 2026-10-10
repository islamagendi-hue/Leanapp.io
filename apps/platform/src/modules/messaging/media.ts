import "server-only";
import type { Db } from "@/lib/db";
import type { WhatsAppHeader } from "@/modules/media/channel-rules";
import { MediaUnavailableError, resolveMediaForSend } from "@/modules/media/service";
import { providerMediaSupport } from "./providers/registry";

/**
 * The one seam between messaging and the media library (src/modules/media).
 * Steps and campaigns store media asset ids (`mediaAssetId`); at validation
 * and send time this resolves an id to the asset's metadata and a durable
 * public URL that the provider fetches (WhatsApp `link`, Twilio `MediaUrl`).
 * The file is checked against the channel, the WhatsApp template's header
 * type and the provider's declared media limits. When it can't be attached,
 * callers get `available: false` with the reason; it is never treated as sent.
 */
export interface ResolvedMedia {
  url: string;
  mime: string;
  size: number;
}

export type MediaResolution = { available: true; media: ResolvedMedia } | { available: false; reason: string };

export async function resolveMedia(
  _db: Db,
  ref: { organizationId: string; appId: string; assetId: string; channel: "whatsapp" | "sms"; provider: string; whatsappHeader?: string | null },
): Promise<MediaResolution> {
  const header = ref.whatsappHeader?.toUpperCase();
  try {
    const m = await resolveMediaForSend(ref.organizationId, ref.appId, ref.assetId, {
      channel: ref.channel,
      provider: ref.provider,
      whatsappHeader: ref.channel === "whatsapp" && header ? (header as WhatsAppHeader) : undefined,
      providerMedia: providerMediaSupport(ref.provider, ref.channel),
    });
    return { available: true, media: { url: m.url, mime: m.mime, size: m.sizeBytes } };
  } catch (err) {
    if (err instanceof MediaUnavailableError) return { available: false, reason: err.message };
    throw err;
  }
}
