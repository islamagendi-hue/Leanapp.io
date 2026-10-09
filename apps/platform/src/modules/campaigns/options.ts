/** Campaign choices and the form shape, shared with the client form. Pure. */
import { msg } from "@/i18n/translate";

export const CHANNELS = ["push", "in_app", "email", "whatsapp", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];
/** Channel names, translated where shown (WhatsApp is a product name). */
export const CHANNEL_LABELS: Record<Channel, string> = { push: msg("Push"), in_app: msg("In-app"), email: msg("Email"), whatsapp: "WhatsApp", sms: "SMS" };

export const SCHEDULES = ["now", "later", "daily", "weekly"] as const;
export type ScheduleMode = (typeof SCHEDULES)[number];

/** The campaign form, as submitted (all strings). */
export interface CampaignForm {
  audienceId?: string;
  channel?: string;
  title?: string;
  body?: string;
  deepLink?: string;
  buttonText?: string;
  emailTemplateId?: string;
  subject?: string;
  whatsappTemplate?: string; // "name|language"
  whatsappParams?: string; // one value per line
  whatsappHeaderParams?: string; // one value per line (a text header variable)
  /** Connected WhatsApp provider: whatsapp_cloud (Meta) or twilio. */
  whatsappProvider?: string;
  /** Media library asset: a WhatsApp template media header, or an MMS image (SMS through a provider that declares MMS). */
  mediaAssetId?: string;
  phoneProperty?: string;
  schedule?: string;
  sendAt?: string; // YYYY-MM-DDTHH:MM, organization timezone
  time?: string; // HH:MM
  weekday?: string;
  capMessages?: string;
  capHours?: string;
  quietHours?: string; // "on" to respect quiet hours
}
