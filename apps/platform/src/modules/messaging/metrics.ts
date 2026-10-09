/**
 * What each channel can report about a message after it is sent. A metric
 * the provider (or the app) gives us no signal for is "not available", with
 * the reason, and is never estimated. Pure; shared by the Channels & delivery
 * page and campaign pages.
 */
import { msg } from "@/i18n/translate";

export const DELIVERY_CHANNELS = ["push", "email", "whatsapp", "in_app"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const DELIVERY_CHANNEL_LABELS: Record<DeliveryChannel, string> = { push: msg("Push"), email: msg("Email"), whatsapp: "WhatsApp", in_app: msg("In-app") };

export const FUNNEL_METRICS = ["delivered", "opened", "clicked"] as const;
export type FunnelMetric = (typeof FUNNEL_METRICS)[number];

/** null: available. A string: why it isn't. */
export const UNAVAILABLE: Record<DeliveryChannel, Record<FunnelMetric, string | null>> = {
  push: {
    delivered: msg("FCM and APNs don't report delivery to the sender."),
    opened: msg("Needs push-open tracking in the SDKs, which isn't built yet."),
    clicked: msg("Needs push-open tracking in the SDKs, which isn't built yet."),
  },
  email: {
    delivered: msg("Needs Resend delivery events (a Resend webhook), which aren't connected yet."),
    opened: msg("Needs Resend open events, which aren't connected yet."),
    clicked: msg("Needs Resend click events, which aren't connected yet."),
  },
  whatsapp: {
    delivered: null,
    opened: null,
    clicked: msg("WhatsApp doesn't report link clicks."),
  },
  in_app: {
    delivered: msg("The app reports when a message is shown, not when it is fetched."),
    opened: null,
    clicked: null,
  },
};

/** What "opened" means per channel, where it is available. */
export const OPENED_MEANS: Partial<Record<DeliveryChannel, string>> = {
  whatsapp: msg("Read receipts. People who turned read receipts off never count as read."),
  in_app: msg("Shown in the app (reported by your app through the in-app API)."),
};

export interface DeliveryCounts {
  sent: number;
  failed: number;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
}

/** Hides counts the channel can't report (they'd always be 0, which reads as "nobody"). */
export function applyAvailability(channel: DeliveryChannel, raw: { sent: number; failed: number; delivered: number; opened: number; clicked: number }): DeliveryCounts {
  const u = UNAVAILABLE[channel];
  return {
    sent: raw.sent,
    failed: raw.failed,
    delivered: u.delivered ? null : raw.delivered,
    opened: u.opened ? null : raw.opened,
    clicked: u.clicked ? null : raw.clicked,
  };
}

/** A share of sent, or null when it can't be computed. */
export function rateOf(n: number | null, sent: number): number | null {
  return n === null || sent === 0 ? null : n / sent;
}
