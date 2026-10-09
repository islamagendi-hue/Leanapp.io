/**
 * Whether a media asset can go out on a channel, from the channel's documented
 * limits and what the provider and the app declare they support. Used by the
 * MediaPicker (to grey out what won't work), when a message is saved, and at
 * send time (resolveMediaForSend). Pure.
 *
 * Sources (checked 2026-10; re-check when a provider changes its limits):
 *  - FCM: `notification.image` is an HTTPS URL; images up to 1 MB; JPEG, PNG
 *    and BMP are documented across platforms (firebase.google.com/docs/cloud-messaging/android/send-image,
 *    …/ios/send-image). Android shows it with no app code; iOS needs a
 *    Notification Service Extension in the app (mutable-content) that
 *    downloads and attaches the image, otherwise the push shows text only.
 *  - APNs attachments (UNNotificationAttachment): images up to 10 MB (JPEG, GIF, PNG).
 *  - WhatsApp Cloud API media (developers.facebook.com/docs/whatsapp/cloud-api/reference/media):
 *    image JPEG/PNG up to 5 MB; video MP4/3GPP (H.264 + AAC) up to 16 MB;
 *    document (PDF here) up to 100 MB; WebP is for stickers only. A template's
 *    header type (IMAGE, VIDEO, DOCUMENT, TEXT) is fixed when Meta approves it:
 *    the media is a runtime value, but it must match that header type.
 *  - Web push (Notification `image`): shown by Chromium browsers; Safari and
 *    Firefox ignore it and show text.
 *  - Email: images are linked from a public HTTPS URL (not attached); JPEG,
 *    PNG and GIF render widely, WebP does not in desktop Outlook.
 *  - SMS: text only. Media only when the provider declares MMS support with its limits.
 */
import { msg } from "@/i18n/translate";
import { fill } from "@/modules/automation/messages";
import type { MediaKind } from "./signature";

export const MEDIA_CHANNELS = ["push", "web_push", "in_app", "email", "whatsapp", "sms"] as const;
export type MediaChannel = (typeof MEDIA_CHANNELS)[number];
export const isMediaChannel = (v: unknown): v is MediaChannel => typeof v === "string" && (MEDIA_CHANNELS as readonly string[]).includes(v);

/** What a provider says it accepts (the messaging provider capability descriptors use this shape). */
export interface ProviderMediaSupport {
  kind: "image" | "video" | "document" | "audio";
  mimeTypes: string[];
  maxBytes: number;
}

export type WhatsAppHeader = "IMAGE" | "VIDEO" | "DOCUMENT" | "TEXT" | "LOCATION" | "NONE";

export interface ChannelCapability {
  channel: MediaChannel;
  provider?: string;
  /** Push: the platforms the message goes to (default both). */
  platforms?: ("android" | "ios")[];
  /** Push to iOS: the app declares a Notification Service Extension that downloads and attaches images. */
  iosNotificationServiceExtension?: boolean;
  /** WhatsApp template message: the approved template's header format. Undefined for a session (free-form) message. */
  whatsappHeader?: WhatsAppHeader;
  /** Media the provider declares it accepts. Required for SMS (MMS); narrows the defaults on other channels. */
  providerMedia?: ProviderMediaSupport[];
}

export interface MediaFacts {
  mime: string;
  kind: MediaKind;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  animated?: boolean;
  deleted?: boolean;
}

export interface MediaIssue {
  code: string;
  message: string;
  params?: Record<string, string | number>;
}

export interface MediaCheck {
  ok: boolean;
  errors: MediaIssue[];
  warnings: MediaIssue[];
  /** The provider fetches the file itself, so it needs a durable public HTTPS URL (never a short-lived signed one). */
  requiresPublicUrl: boolean;
}

const MB = 1024 * 1024;

interface Rule {
  mimes: string[];
  maxBytes: number;
}

/** Channel defaults: allowed types and size, per media kind. */
const WHATSAPP: Record<"IMAGE" | "VIDEO" | "DOCUMENT", Rule> = {
  IMAGE: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
  VIDEO: { mimes: ["video/mp4", "video/3gpp"], maxBytes: 16 * MB },
  DOCUMENT: { mimes: ["application/pdf"], maxBytes: 100 * MB },
};

const RULES: Record<Exclude<MediaChannel, "whatsapp" | "sms">, Rule> = {
  push: { mimes: ["image/jpeg", "image/png"], maxBytes: 1 * MB },
  web_push: { mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 1 * MB },
  in_app: { mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 5 * MB },
  email: { mimes: ["image/jpeg", "image/png", "image/gif", "image/webp"], maxBytes: 5 * MB },
};

const mbText = (n: number) => (n / MB >= 1 ? `${Math.round((n / MB) * 10) / 10} MB` : `${Math.round(n / 1024)} KB`);

function providerAllows(list: ProviderMediaSupport[], a: MediaFacts): ProviderMediaSupport | null {
  return list.find((p) => p.mimeTypes.map((m) => m.toLowerCase()).includes(a.mime) && a.sizeBytes <= p.maxBytes) ?? null;
}

/** The types the picker should offer for a channel (before size checks). */
export function acceptedMimes(cap: ChannelCapability): string[] {
  if (cap.channel === "sms") return [...new Set((cap.providerMedia ?? []).flatMap((p) => p.mimeTypes.map((m) => m.toLowerCase())))];
  let base: string[];
  if (cap.channel === "whatsapp") {
    const h = cap.whatsappHeader;
    if (h === "IMAGE" || h === "VIDEO" || h === "DOCUMENT") base = WHATSAPP[h].mimes;
    else if (h) base = [];
    else base = [...WHATSAPP.IMAGE.mimes, ...WHATSAPP.VIDEO.mimes, ...WHATSAPP.DOCUMENT.mimes];
  } else base = RULES[cap.channel].mimes;
  if (cap.providerMedia?.length) {
    const declared = new Set(cap.providerMedia.flatMap((p) => p.mimeTypes.map((m) => m.toLowerCase())));
    base = base.filter((m) => declared.has(m));
  }
  return base;
}

export function validateMediaForChannel(asset: MediaFacts, cap: ChannelCapability): MediaCheck {
  const errors: MediaIssue[] = [];
  const warnings: MediaIssue[] = [];
  const err = (code: string, message: string, params?: MediaIssue["params"]) => errors.push({ code, message, params });
  const warn = (code: string, message: string, params?: MediaIssue["params"]) => warnings.push({ code, message, params });
  const requiresPublicUrl = cap.channel !== "sms" || Boolean(cap.providerMedia?.length);

  if (asset.deleted) err("deleted", msg("This file was deleted from the media library."));

  const checkRule = (rule: Rule, typeMessage: string) => {
    if (!rule.mimes.includes(asset.mime)) err("type", typeMessage);
    else if (asset.sizeBytes > rule.maxBytes) err("size", msg("The file is larger than {limit}, the limit for this channel."), { limit: mbText(rule.maxBytes) });
  };

  switch (cap.channel) {
    case "sms": {
      if (!cap.providerMedia?.length) err("sms_no_media", msg("SMS carries text only. Media needs an SMS provider that declares MMS support."));
      break;
    }
    case "whatsapp": {
      const h = cap.whatsappHeader;
      if (h === "TEXT" || h === "LOCATION" || h === "NONE") {
        err("whatsapp_header", msg("This WhatsApp template has no media header. The header type is fixed when Meta approves the template."));
      } else if (h) {
        checkRule(WHATSAPP[h], h === "IMAGE"
          ? msg("This template's header is an image: use a JPEG or PNG.")
          : h === "VIDEO" ? msg("This template's header is a video: use an MP4 or 3GP file.") : msg("This template's header is a document: use a PDF."));
      } else {
        const rule = Object.values(WHATSAPP).find((r) => r.mimes.includes(asset.mime));
        if (!rule) err("type", msg("WhatsApp accepts JPEG or PNG images, MP4 or 3GP video, and PDF documents."));
        else checkRule(rule, "");
      }
      if (asset.mime === "image/webp") warn("whatsapp_webp", msg("WhatsApp uses WebP only for stickers."));
      break;
    }
    case "push": {
      checkRule(RULES.push, msg("Push images must be JPEG or PNG, which Android and iOS both show."));
      const platforms = cap.platforms ?? ["android", "ios"];
      if (platforms.includes("ios") && !cap.iosNotificationServiceExtension) {
        warn("ios_extension", msg("iOS shows push images only when the app has a Notification Service Extension that downloads them; otherwise iOS devices get the text only."));
      }
      if (asset.width && asset.height && (asset.width / asset.height > 3 || asset.width / asset.height < 1)) {
        warn("push_aspect", msg("Expanded Android notifications crop images to about 2:1; this one may be cut off."));
      }
      break;
    }
    case "web_push": {
      checkRule(RULES.web_push, msg("Web push images must be JPEG, PNG, WebP or GIF."));
      warn("web_push_browsers", msg("Chrome and Edge show the image; Safari and Firefox show the text only."));
      break;
    }
    case "in_app": {
      checkRule(RULES.in_app, msg("In-app images must be JPEG, PNG, WebP or GIF."));
      warn("in_app_render", msg("The image is sent with the message; your app's in-app message view must display it."));
      break;
    }
    case "email": {
      checkRule(RULES.email, msg("Email images must be JPEG, PNG or GIF. Link to video and PDF files instead of embedding them."));
      if (asset.mime === "image/webp") warn("email_webp", msg("Desktop Outlook doesn't show WebP images. JPEG or PNG is safer."));
      if (asset.sizeBytes > 1 * MB) warn("email_size", msg("Images over 1 MB load slowly in email."));
      break;
    }
  }

  // A provider's own declaration can only narrow what the channel allows (or, for SMS, enable MMS).
  if (cap.providerMedia?.length && !errors.some((e) => e.code === "deleted") && !providerAllows(cap.providerMedia, asset)) {
    if (!errors.some((e) => e.code === "type" || e.code === "size")) err("provider", msg("The provider ({provider}) doesn't accept this file type or size."), { provider: cap.provider ?? "-" });
  }

  return { ok: errors.length === 0, errors, warnings, requiresPublicUrl };
}

/** An issue as English text with its values filled in (translateMessage translates it back by template). */
export const issueText = (i: MediaIssue) => (i.params ? fill(i.message, i.params) : i.message);
