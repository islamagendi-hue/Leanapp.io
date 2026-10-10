/**
 * Hooks for providers that want media uploaded to them rather than fetched
 * from a link (e.g. WhatsApp Cloud API `POST /{phone-number-id}/media`, which
 * returns a media id valid for 30 days). Interfaces only: provider adapters
 * (src/modules/messaging) implement them. Every sender in this codebase today
 * uses the durable public link from resolveMediaForSend, which Meta, FCM, APNs
 * service extensions and email clients all accept, so no implementation is
 * registered and nothing here calls a provider.
 */
import type { MediaChannel } from "./channel-rules";
import type { MediaMime } from "./signature";

export interface ProviderMediaUploadInput {
  organizationId: string;
  appId: string;
  assetId: string;
  /** The provider connection (integration row) the upload is for. */
  connectionId: string;
  bytes: Uint8Array;
  mime: MediaMime;
  filename: string;
}

export interface ProviderMediaUploadResult {
  /** The provider's id for the uploaded media. */
  providerMediaId: string;
  /** When the provider forgets it (WhatsApp: 30 days), so callers re-upload in time. */
  expiresAt: Date | null;
}

export interface ProviderMediaUploader {
  /** The provider key, matching the messaging provider capability descriptors. */
  readonly provider: string;
  readonly channels: readonly MediaChannel[];
  upload(input: ProviderMediaUploadInput): Promise<ProviderMediaUploadResult>;
  /** Optional: delete the provider's copy when the asset is replaced or deleted. */
  remove?(input: { connectionId: string; providerMediaId: string }): Promise<void>;
}
