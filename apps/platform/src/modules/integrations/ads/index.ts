import type { AdProvider } from "../registry";
import { googleAdapter } from "./google";
import { metaAdapter } from "./meta";
import { snapchatAdapter } from "./snapchat";
import { tiktokAdapter } from "./tiktok";
import type { AdAdapter } from "./types";

export const AD_ADAPTERS: Record<AdProvider, AdAdapter> = {
  meta_ads: metaAdapter,
  google_ads: googleAdapter,
  tiktok_ads: tiktokAdapter,
  snapchat_ads: snapchatAdapter,
};

export type { AdAdapter } from "./types";
