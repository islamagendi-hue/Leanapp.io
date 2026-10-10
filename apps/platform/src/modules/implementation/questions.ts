/**
 * Adaptive implementation questionnaire.
 *
 * Questions declare `when` (shown only if earlier answers make them relevant)
 * and may compute their options from earlier answers (activation and
 * north-star candidates depend on the business model). The UI asks one
 * section at a time; `nextQuestions` returns what to show next.
 */
import { msg } from "@/i18n/translate";
import { classifyBusiness } from "./classifier";
import {
  ATTRIBUTION_CHANNELS, BUSINESS_MODELS, CHANNEL_LABELS, FEATURE_LABELS, FEATURES, MODEL_LABELS, MODELS,
  type BusinessModel,
} from "./catalog/models";
import { EVENT_LIBRARY } from "./catalog/events";

export const QUESTION_CATALOG_VERSION = 1;

export type Answers = Record<string, AnswerValue>;
export type AnswerValue = string | string[] | boolean | null;

export interface Option {
  value: string;
  label: string;
}

export type QuestionType = "text" | "longtext" | "single" | "multi" | "boolean";

export interface Question {
  key: string;
  section: SectionKey;
  type: QuestionType;
  prompt: string;
  help?: string;
  required: boolean;
  options?: Option[] | ((a: Answers) => Option[]);
  /** Suggested default from earlier answers (pre-selected, user can change). */
  suggest?: (a: Answers) => AnswerValue;
  when?: (a: Answers) => boolean;
  /** Allow a free-text "Other" alongside choices. */
  allowOther?: boolean;
  placeholder?: string;
}

export const SECTIONS = [
  { key: "business", title: msg("Your business"), intro: msg("Let's understand your app.") },
  { key: "app", title: msg("Your app"), intro: msg("What people do in the app.") },
  { key: "monetization", title: msg("How you make money"), intro: msg("So revenue is tracked from the right place.") },
  { key: "journey", title: msg("Customer journey"), intro: msg("In your own words.") },
  { key: "attribution", title: msg("Where users come from"), intro: msg("So every install and conversion keeps its source.") },
  { key: "value", title: msg("Activation and value"), intro: msg("The moments that matter most.") },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];

const opts = (pairs: [string, string][]): Option[] => pairs.map(([value, label]) => ({ value, label }));
const has = (a: Answers, key: string, value: string) => Array.isArray(a[key]) && (a[key] as string[]).includes(value);
const model = (a: Answers): BusinessModel => classifyBusiness(a).primary;

const COUNTRIES = opts([
  ["SA", msg("Saudi Arabia")], ["AE", msg("UAE")], ["EG", msg("Egypt")], ["KW", msg("Kuwait")], ["QA", msg("Qatar")], ["BH", msg("Bahrain")], ["OM", msg("Oman")],
  ["JO", msg("Jordan")], ["LB", msg("Lebanon")], ["IQ", msg("Iraq")], ["MA", msg("Morocco")], ["OTHER", msg("Other countries")],
]);
const COUNTRY_CURRENCY: Record<string, string> = { SA: "SAR", AE: "AED", EG: "EGP", KW: "KWD", QA: "QAR", BH: "BHD", OM: "OMR", JO: "JOD", LB: "LBP", IQ: "IQD", MA: "MAD" };
const CURRENCIES = opts([
  ["SAR", "SAR"], ["AED", "AED"], ["EGP", "EGP"], ["KWD", "KWD"], ["QAR", "QAR"], ["BHD", "BHD"], ["OMR", "OMR"], ["JOD", "JOD"],
  ["LBP", "LBP"], ["IQD", "IQD"], ["MAD", "MAD"], ["USD", "USD"], ["EUR", "EUR"],
]);

function eventOptions(names: string[]): Option[] {
  return [...new Set(names)].filter((n) => EVENT_LIBRARY[n]).map((n) => ({ value: n, label: `${EVENT_LIBRARY[n].display} (${n})` }));
}

export const QUESTIONS: Question[] = [
  // ── Business ──────────────────────────────────────────────────────────────
  { key: "business.description", section: "business", type: "longtext", required: true, prompt: msg("What does your company do?"), placeholder: msg("We are a food delivery app in Riyadh and Jeddah…"), help: msg("A sentence or two is enough. Arabic or English.") },
  { key: "business.problem", section: "business", type: "longtext", required: false, prompt: msg("What problem does the app solve?") },
  {
    key: "business.model", section: "business", type: "single", required: true, prompt: msg("Which business model fits best?"),
    options: BUSINESS_MODELS.map((m) => ({ value: m, label: MODEL_LABELS[m] })),
    suggest: (a) => (a["business.description"] ? classifyBusiness({ ...a, "business.model": null }).primary : null),
    help: msg("We picked one from your description. Change it if it's wrong."),
  },
  { key: "business.customer_type", section: "business", type: "single", required: true, prompt: msg("Who is the customer?"), options: opts([["b2c", msg("Consumers (B2C)")], ["b2b", msg("Businesses (B2B)")], ["marketplace", msg("Both sides of a marketplace")], ["hybrid", msg("Hybrid")]]), suggest: (a) => (a["business.model"] === "marketplace" ? "marketplace" : a["business.model"] === "saas" ? "b2b" : "b2c") },
  { key: "business.countries", section: "business", type: "multi", required: true, prompt: msg("Which countries do you operate in?"), options: COUNTRIES },
  {
    key: "business.currencies", section: "business", type: "multi", required: true, prompt: msg("Which currencies do customers pay in?"), options: CURRENCIES,
    suggest: (a) => {
      const c = ((a["business.countries"] as string[]) ?? []).map((x) => COUNTRY_CURRENCY[x]).filter(Boolean);
      return c.length ? [...new Set(c)] : null;
    },
  },
  { key: "business.value", section: "business", type: "longtext", required: false, prompt: msg("What is the main value users get?"), placeholder: msg("Hot food delivered in under 40 minutes.") },

  // ── App ───────────────────────────────────────────────────────────────────
  { key: "app.primary_action", section: "app", type: "text", required: true, prompt: msg("What does a user primarily do in the app?"), placeholder: msg("Order food from nearby restaurants") },
  { key: "app.first_action", section: "app", type: "text", required: false, prompt: msg("What should a new user do first?"), placeholder: msg("Set their delivery address and browse restaurants") },
  { key: "app.has_signup", section: "app", type: "boolean", required: true, prompt: msg("Do users create an account?") },
  { key: "app.has_onboarding", section: "app", type: "boolean", required: true, prompt: msg("Is there an onboarding flow after install or signup?") },
  {
    key: "app.features", section: "app", type: "multi", required: true, prompt: msg("Which of these does your app have?"),
    options: FEATURES.filter((f) => f !== "onboarding").map((f) => ({ value: f, label: FEATURE_LABELS[f] })),
    suggest: (a) => MODELS[model(a)].defaultFeatures.filter((f) => f !== "onboarding"),
  },
  { key: "app.multiple_user_types", section: "app", type: "boolean", required: true, prompt: msg("Are there different kinds of users (e.g. buyers and sellers, students and teachers)?"), suggest: (a) => (a["business.model"] === "marketplace" ? true : null) },
  { key: "app.user_types", section: "app", type: "text", required: true, prompt: msg("List the user types, separated by commas."), placeholder: msg("buyer, seller"), when: (a) => a["app.multiple_user_types"] === true },
  { key: "app.return_driver", section: "app", type: "text", required: false, prompt: msg("What makes users come back?"), placeholder: msg("Weekly offers and reordering favourites") },
  { key: "app.churn_causes", section: "app", type: "text", required: false, prompt: msg("Why do users stop using the app, if you know?") },

  // ── Monetization ──────────────────────────────────────────────────────────
  {
    key: "monetization.streams", section: "monetization", type: "multi", required: true, prompt: msg("How do you make money?"),
    options: opts([["one_time", msg("One-time purchases / orders")], ["subscriptions", msg("Subscriptions")], ["commission", msg("Commissions / service fees")], ["iap", msg("In-app purchases (store billing)")], ["ads", msg("Advertising")], ["leads", msg("Selling or qualifying leads")], ["none", msg("Not monetised yet")]]),
    suggest: (a) => {
      const m = model(a);
      return ({ ecommerce: ["one_time"], delivery: ["one_time", "commission"], marketplace: ["commission"], subscription: ["subscriptions"], saas: ["subscriptions"], gaming: ["iap"], advertising: ["ads"], lead_generation: ["leads"], fintech: ["commission"], booking: ["one_time"], healthcare: ["one_time"] } as Partial<Record<BusinessModel, string[]>>)[m] ?? null;
    },
  },
  {
    key: "monetization.payment_confirmation", section: "monetization", type: "single", required: true,
    prompt: msg("Where is a payment confirmed?"),
    help: msg("Revenue should come from the system that knows the payment succeeded."),
    options: opts([["backend", msg("Our backend / payment provider webhook")], ["store", msg("App Store / Google Play (store billing)")], ["client_only", msg("Only in the app (no server confirmation)")], ["cash", msg("Cash on delivery, confirmed by our ops")]]),
    when: (a) => Array.isArray(a["monetization.streams"]) && !has(a, "monetization.streams", "none") && (a["monetization.streams"] as string[]).some((s) => ["one_time", "subscriptions", "commission", "iap"].includes(s)),
  },
  { key: "monetization.billing_periods", section: "monetization", type: "multi", required: true, prompt: msg("Which billing periods do you offer?"), options: opts([["weekly", msg("Weekly")], ["monthly", msg("Monthly")], ["quarterly", msg("Quarterly")], ["yearly", msg("Yearly")], ["lifetime", msg("Lifetime")]]), when: (a) => has(a, "monetization.streams", "subscriptions") },
  { key: "monetization.has_trial", section: "monetization", type: "boolean", required: true, prompt: msg("Do you offer a free trial?"), when: (a) => has(a, "monetization.streams", "subscriptions") },
  { key: "monetization.has_refunds", section: "monetization", type: "boolean", required: true, prompt: msg("Do you issue refunds or partial refunds?"), when: (a) => has(a, "monetization.streams", "one_time") || has(a, "monetization.streams", "commission") },

  // ── Journey ───────────────────────────────────────────────────────────────
  {
    key: "journey.description", section: "journey", type: "longtext", required: true,
    prompt: msg("How does someone go from discovering your app to becoming a customer?"),
    placeholder: msg("Users see a TikTok ad, install the app, register, browse products, add products to cart, checkout and pay."),
    help: msg("Describe it step by step in plain language. We turn it into events."),
  },

  // ── Attribution ───────────────────────────────────────────────────────────
  { key: "attribution.channels", section: "attribution", type: "multi", required: true, prompt: msg("Where do your users come from?"), options: ATTRIBUTION_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })) },
  { key: "attribution.main_channel", section: "attribution", type: "single", required: false, prompt: msg("Which one brings the most users?"), options: (a) => ((a["attribution.channels"] as string[]) ?? []).map((c) => ({ value: c, label: CHANNEL_LABELS[c as keyof typeof CHANNEL_LABELS] ?? c })), when: (a) => Array.isArray(a["attribution.channels"]) && (a["attribution.channels"] as string[]).length > 1 },
  { key: "attribution.existing_mmp", section: "attribution", type: "single", required: true, prompt: msg("Do you already use a mobile measurement partner?"), options: opts([["none", msg("No")], ["appsflyer", "AppsFlyer"], ["adjust", "Adjust"], ["branch", "Branch"], ["other", msg("Another one")]]) },
  {
    key: "attribution.authoritative", section: "attribution", type: "single", required: true, prompt: msg("Which should be the source of truth for attribution?"),
    help: msg("You don't have to remove your MMP. We can receive its attribution and use it as authoritative."),
    options: opts([["mmp", msg("Keep my MMP as source of truth")], ["native", msg("Use this platform's native attribution")]]),
    when: (a) => typeof a["attribution.existing_mmp"] === "string" && a["attribution.existing_mmp"] !== "none",
  },

  // ── Value ─────────────────────────────────────────────────────────────────
  {
    key: "value.activation_event", section: "value", type: "single", required: true,
    prompt: msg("What action proves a user received value from your product?"),
    help: msg("This is your activation moment. Signup alone usually isn't it."),
    options: (a) => eventOptions([...MODELS[model(a)].activationCandidates, "signup_completed", "onboarding_completed"]),
    suggest: (a) => MODELS[model(a)].activationCandidates[0] ?? null,
    allowOther: true,
  },
  {
    key: "value.north_star_event", section: "value", type: "single", required: true,
    prompt: msg("Which repeated behaviour best represents the value your product creates?"),
    help: msg("Your north star. We'll use it across analytics."),
    options: (a) => eventOptions([...MODELS[model(a)].northStarCandidates, ...MODELS[model(a)].activationCandidates]),
    suggest: (a) => MODELS[model(a)].northStarCandidates[0] ?? null,
    allowOther: true,
  },
];

export const QUESTION_BY_KEY: Record<string, Question> = Object.fromEntries(QUESTIONS.map((q) => [q.key, q]));

export function isVisible(q: Question, a: Answers): boolean {
  return q.when ? q.when(a) : true;
}

export function optionsFor(q: Question, a: Answers): Option[] {
  return typeof q.options === "function" ? q.options(a) : (q.options ?? []);
}

function isAnswered(q: Question, a: Answers): boolean {
  if (!(q.key in a)) return false;
  const v = a[q.key];
  if (!q.required) return true; // explicitly skipped (null) counts
  if (v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** The next section with unanswered visible questions, and those questions. */
export function nextQuestions(a: Answers): { section: (typeof SECTIONS)[number]; questions: Question[] } | null {
  for (const section of SECTIONS) {
    const qs = QUESTIONS.filter((q) => q.section === section.key && isVisible(q, a));
    if (qs.some((q) => !isAnswered(q, a))) return { section, questions: qs };
  }
  return null;
}

export function progress(a: Answers): { answered: number; total: number; complete: boolean } {
  const visible = QUESTIONS.filter((q) => isVisible(q, a));
  const answered = visible.filter((q) => isAnswered(q, a)).length;
  return { answered, total: visible.length, complete: answered === visible.length };
}

/**
 * Validates and coerces submitted form values for one section. Unknown keys
 * and invisible questions are dropped; choices must be valid options (or a
 * free-text "other" where allowed).
 */
export function coerceAnswers(section: SectionKey, raw: Record<string, unknown>, current: Answers): { answers: Answers; errors: Record<string, string> } {
  const out: Answers = {};
  const errors: Record<string, string> = {};
  const merged = { ...current };
  for (const q of QUESTIONS.filter((x) => x.section === section)) {
    if (!isVisible(q, merged)) continue;
    // A follow-up that only became visible through this submission is asked next, not failed.
    if (!(q.key in raw) && !isVisible(q, current)) continue;
    const v = raw[q.key];
    let value: AnswerValue = null;
    if (q.type === "boolean") {
      value = v === true || v === "true" ? true : v === false || v === "false" ? false : null;
    } else if (q.type === "multi") {
      const arr = (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]).map(String);
      const allowed = new Set(optionsFor(q, merged).map((o) => o.value));
      value = arr.filter((x) => allowed.has(x));
    } else if (q.type === "single") {
      const s = typeof v === "string" ? v.trim() : "";
      const allowed = new Set(optionsFor(q, merged).map((o) => o.value));
      if (s && (allowed.has(s) || (q.allowOther && /^[a-z][a-z0-9_]{1,63}$/.test(s)))) value = s;
      else if (s) errors[q.key] = q.allowOther ? msg("Choose an option or enter an event name in snake_case.") : msg("Choose an option.");
    } else {
      const s = typeof v === "string" ? v.trim().slice(0, 2000) : "";
      value = s || null;
    }
    const empty = value === null || (Array.isArray(value) && value.length === 0);
    if (q.required && empty && !errors[q.key]) errors[q.key] = msg("This question needs an answer.");
    out[q.key] = value;
    merged[q.key] = value;
  }
  return { answers: out, errors };
}
