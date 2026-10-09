import "server-only";
import type { Db } from "@/lib/db";
import { msg } from "@/i18n/translate";
import type { MessagingChannel } from "./providers/registry";

/**
 * The one seam between messaging and the media library (src/modules/media,
 * built in a separate workstream). Steps and campaigns store media asset ids
 * (`mediaAssetId`); at validation and send time this resolves an id to the
 * asset's metadata and a durable public URL that the provider fetches
 * (WhatsApp `link`, Twilio `MediaUrl`).
 *
 * Until the media library is merged, nothing resolves: callers get
 * `available: false` and the send is logged as failed with that reason. It is
 * never treated as sent.
 *
 * MERGE: replace the body of `resolveMedia` with a call to the media module's
 * `resolveMediaForSend(organizationId, appId, assetId, channel)`, which returns
 * { url, mime, size }.
 */
export interface ResolvedMedia {
  url: string;
  mime: string;
  size: number;
}

export type MediaResolution = { available: true; media: ResolvedMedia } | { available: false; reason: string };

export const MEDIA_LIBRARY_MISSING = msg("The media library isn't available on this server, so media can't be attached yet.");

export async function resolveMedia(
  _db: Db,
  _ref: { organizationId: string; appId: string; assetId: string; channel: MessagingChannel },
): Promise<MediaResolution> {
  return { available: false, reason: MEDIA_LIBRARY_MISSING };
}
