import { msg } from "@/i18n/translate";

/** Countries offered in organization forms: [ISO code, name (translated where shown), timezone, currency]. MENA first; "Other" is always available. */
export const COUNTRIES: [string, string, string, string][] = [
  ["SA", msg("Saudi Arabia"), "Asia/Riyadh", "SAR"], ["AE", msg("United Arab Emirates"), "Asia/Dubai", "AED"], ["EG", msg("Egypt"), "Africa/Cairo", "EGP"],
  ["KW", msg("Kuwait"), "Asia/Kuwait", "KWD"], ["QA", msg("Qatar"), "Asia/Qatar", "QAR"], ["BH", msg("Bahrain"), "Asia/Bahrain", "BHD"],
  ["OM", msg("Oman"), "Asia/Muscat", "OMR"], ["JO", msg("Jordan"), "Asia/Amman", "JOD"], ["LB", msg("Lebanon"), "Asia/Beirut", "LBP"],
  ["IQ", msg("Iraq"), "Asia/Baghdad", "IQD"], ["MA", msg("Morocco"), "Africa/Casablanca", "MAD"],
];

export const TIMEZONES = [...new Set(COUNTRIES.map((c) => c[2])), "UTC", "Europe/London"];
export const CURRENCIES = [...new Set(COUNTRIES.map((c) => c[3])), "USD", "EUR"];
