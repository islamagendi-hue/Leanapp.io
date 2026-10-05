/** Countries offered in organization forms: [ISO code, name, timezone, currency]. MENA first; "Other" is always available. */
export const COUNTRIES: [string, string, string, string][] = [
  ["SA", "Saudi Arabia", "Asia/Riyadh", "SAR"], ["AE", "United Arab Emirates", "Asia/Dubai", "AED"], ["EG", "Egypt", "Africa/Cairo", "EGP"],
  ["KW", "Kuwait", "Asia/Kuwait", "KWD"], ["QA", "Qatar", "Asia/Qatar", "QAR"], ["BH", "Bahrain", "Asia/Bahrain", "BHD"],
  ["OM", "Oman", "Asia/Muscat", "OMR"], ["JO", "Jordan", "Asia/Amman", "JOD"], ["LB", "Lebanon", "Asia/Beirut", "LBP"],
  ["IQ", "Iraq", "Asia/Baghdad", "IQD"], ["MA", "Morocco", "Africa/Casablanca", "MAD"],
];

export const TIMEZONES = [...new Set(COUNTRIES.map((c) => c[2])), "UTC", "Europe/London"];
export const CURRENCIES = [...new Set(COUNTRIES.map((c) => c[3])), "USD", "EUR"];
