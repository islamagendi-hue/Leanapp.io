/**
 * Business models, product features and journey phrases → events.
 * Also the user-property and attribution libraries, and the per-model
 * activation / north-star candidates.
 */
import { msg } from "@/i18n/translate";
import type { PropertySetKey } from "./properties";

export const BUSINESS_MODELS = [
  "ecommerce", "marketplace", "delivery", "subscription", "fintech", "edtech", "healthcare",
  "gaming", "social", "saas", "booking", "lead_generation", "advertising", "other",
] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export const MODEL_LABELS: Record<BusinessModel, string> = {
  ecommerce: msg("E-commerce"), marketplace: msg("Marketplace"), delivery: msg("Delivery"), subscription: msg("Subscription"),
  fintech: msg("Fintech"), edtech: msg("EdTech"), healthcare: msg("Healthcare"), gaming: msg("Gaming"), social: msg("Social"),
  saas: msg("SaaS"), booking: msg("Booking"), lead_generation: msg("Lead generation"), advertising: msg("Advertising"), other: msg("Other"),
};

export const FEATURES = [
  "search", "cart_checkout", "subscriptions", "bookings", "payments_wallet", "messaging", "user_content",
  "reviews", "referrals", "rewards", "push", "deep_links", "wishlist", "onboarding",
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  search: msg("Search"), cart_checkout: msg("Cart & checkout"), subscriptions: msg("Subscriptions"), bookings: msg("Bookings / appointments"),
  payments_wallet: msg("Payments / wallet"), messaging: msg("Messaging / chat"), user_content: msg("User-generated content"),
  reviews: msg("Reviews / ratings"), referrals: msg("Referrals"), rewards: msg("Rewards / loyalty"), push: msg("Push notifications"),
  deep_links: msg("Deep links"), wishlist: msg("Wishlist / favourites"), onboarding: msg("Onboarding flow"),
};

export interface ModelDefinition {
  events: string[];
  /** Property-set overrides for shared event names (e.g. marketplace purchases carry listing ids). */
  propertyOverrides?: Record<string, PropertySetKey>;
  defaultFeatures: Feature[];
  revenueEvent: string | null;
  activationCandidates: string[];
  northStarCandidates: string[];
  userProperties: string[];
  /** Keywords for classifying free-text descriptions. */
  keywords: string[];
  warnings?: string[];
}

export const MODELS: Record<BusinessModel, ModelDefinition> = {
  ecommerce: {
    events: ["product_list_viewed", "product_viewed", "product_added_to_cart", "product_removed_from_cart", "cart_viewed", "checkout_started", "purchase_completed", "refund_completed"],
    defaultFeatures: ["search", "cart_checkout", "wishlist", "push"],
    revenueEvent: "purchase_completed",
    activationCandidates: ["purchase_completed", "product_added_to_cart", "signup_completed"],
    northStarCandidates: ["purchase_completed"],
    userProperties: ["first_purchase_date", "last_purchase_date", "total_revenue", "order_count", "preferred_category"],
    keywords: ["shop", "store", "ecommerce", "e-commerce", "retail", "products", "fashion", "perfume", "electronics", "cart", "brand", "متجر", "تسوق"],
  },
  marketplace: {
    events: ["listing_viewed", "listing_created", "listing_published", "message_started", "offer_created", "purchase_completed"],
    propertyOverrides: { purchase_completed: "marketplace_purchase" },
    defaultFeatures: ["search", "messaging", "reviews", "push"],
    revenueEvent: "purchase_completed",
    activationCandidates: ["message_started", "listing_published", "purchase_completed"],
    northStarCandidates: ["purchase_completed", "message_started"],
    userProperties: ["buyer_or_seller", "preferred_category", "seller_category", "listing_count", "total_revenue"],
    keywords: ["marketplace", "buyers", "sellers", "buy and sell", "classifieds", "listing", "used cars", "second hand", "سوق"],
  },
  delivery: {
    events: ["vendor_viewed", "menu_viewed", "product_viewed", "product_added_to_cart", "product_removed_from_cart", "cart_viewed", "checkout_started", "order_completed", "order_delivered", "order_cancelled", "review_submitted"],
    propertyOverrides: { product_viewed: "product" },
    defaultFeatures: ["search", "cart_checkout", "reviews", "push"],
    revenueEvent: "order_completed",
    activationCandidates: ["order_completed", "order_delivered"],
    northStarCandidates: ["order_completed"],
    userProperties: ["first_order_date", "last_order_date", "order_count", "total_revenue", "preferred_cuisine", "city"],
    keywords: ["delivery", "deliver", "restaurant", "food", "meals", "grocery", "groceries", "courier", "توصيل", "مطعم"],
  },
  subscription: {
    events: ["paywall_viewed", "trial_started", "subscription_started", "subscription_renewed", "subscription_cancelled", "subscription_expired"],
    defaultFeatures: ["subscriptions", "onboarding", "push"],
    revenueEvent: "subscription_started",
    activationCandidates: ["subscription_started", "trial_started", "onboarding_completed"],
    northStarCandidates: ["subscription_renewed", "subscription_started"],
    userProperties: ["plan", "subscription_status", "subscription_start_date", "trial_status", "total_revenue"],
    keywords: ["subscription", "subscribe", "premium", "membership", "monthly plan", "paywall", "اشتراك"],
  },
  fintech: {
    events: ["kyc_started", "kyc_completed", "kyc_failed", "account_created", "deposit_completed", "transfer_completed"],
    defaultFeatures: ["payments_wallet", "push", "onboarding"],
    revenueEvent: "transfer_completed",
    activationCandidates: ["deposit_completed", "kyc_completed", "transfer_completed"],
    northStarCandidates: ["transfer_completed", "deposit_completed"],
    userProperties: ["account_type", "verification_status", "first_deposit_date", "funded"],
    keywords: ["fintech", "wallet", "bank", "banking", "payments", "transfer", "remittance", "loan", "bnpl", "card", "kyc", "محفظة", "بنك"],
    warnings: [msg("Fintech: never send account numbers, balances, card data or identity documents as properties. Use ids and coarse codes.")],
  },
  edtech: {
    events: ["course_viewed", "course_started", "lesson_started", "lesson_completed", "course_completed"],
    defaultFeatures: ["search", "push", "onboarding"],
    revenueEvent: null,
    activationCandidates: ["lesson_completed", "course_started"],
    northStarCandidates: ["lesson_completed"],
    userProperties: ["student_level", "learning_stage", "courses_count", "preferred_subject"],
    keywords: ["learn", "learning", "course", "courses", "lesson", "students", "education", "tutor", "school", "تعليم", "دورات"],
  },
  healthcare: {
    events: ["provider_viewed", "appointment_booking_started", "appointment_booked", "appointment_cancelled", "consultation_completed"],
    defaultFeatures: ["search", "bookings", "push"],
    revenueEvent: "appointment_booked",
    activationCandidates: ["consultation_completed", "appointment_booked"],
    northStarCandidates: ["consultation_completed"],
    userProperties: ["patient_type", "city", "appointment_count"],
    keywords: ["health", "healthcare", "doctor", "clinic", "patients", "telemedicine", "pharmacy", "medical", "صحة", "طبيب"],
    warnings: [
      msg("Healthcare: do not send diagnoses, conditions, symptoms, prescriptions or other health data as event or user properties. Track specialties only at a broad level and check local health-data rules."),
    ],
  },
  gaming: {
    events: ["tutorial_completed", "level_started", "level_completed", "level_failed", "achievement_unlocked"],
    defaultFeatures: ["push"],
    revenueEvent: "in_app_purchase_completed",
    activationCandidates: ["tutorial_completed", "level_completed"],
    northStarCandidates: ["level_completed"],
    userProperties: ["player_level", "payer_status", "total_revenue"],
    keywords: ["game", "gaming", "players", "levels", "puzzle", "arcade", "لعبة", "ألعاب"],
  },
  social: {
    events: ["profile_completed", "content_viewed", "content_created", "content_liked", "comment_posted", "user_followed", "content_shared"],
    defaultFeatures: ["user_content", "messaging", "push"],
    revenueEvent: null,
    activationCandidates: ["user_followed", "content_created", "comment_posted"],
    northStarCandidates: ["content_created", "comment_posted"],
    userProperties: ["followers_count", "following_count", "creator_status"],
    keywords: ["social", "community", "share", "posts", "creators", "followers", "chat", "dating", "مجتمع"],
  },
  saas: {
    events: ["workspace_created", "teammate_invited", "feature_used"],
    defaultFeatures: ["onboarding", "push"],
    revenueEvent: "subscription_started",
    activationCandidates: ["teammate_invited", "feature_used", "workspace_created"],
    northStarCandidates: ["feature_used"],
    userProperties: ["workspace_role", "company_size", "plan", "subscription_status"],
    keywords: ["saas", "b2b", "teams", "workspace", "productivity", "crm", "dashboard", "software"],
  },
  booking: {
    events: ["availability_searched", "bookable_viewed", "booking_started", "booking_completed", "booking_cancelled", "review_submitted"],
    defaultFeatures: ["search", "bookings", "reviews", "push"],
    revenueEvent: "booking_completed",
    activationCandidates: ["booking_completed"],
    northStarCandidates: ["booking_completed"],
    userProperties: ["booking_count", "last_booking_date", "total_revenue", "city"],
    keywords: ["booking", "book", "reservation", "reserve", "appointments", "hotel", "travel", "salon", "tickets", "حجز"],
  },
  lead_generation: {
    events: ["lead_form_started", "lead_submitted", "lead_qualified"],
    defaultFeatures: ["push"],
    revenueEvent: "lead_qualified",
    activationCandidates: ["lead_submitted"],
    northStarCandidates: ["lead_qualified", "lead_submitted"],
    userProperties: ["lead_status", "interest"],
    keywords: ["leads", "lead generation", "quote", "real estate", "insurance", "car finance", "inquiries", "enquiries"],
  },
  advertising: {
    events: ["content_viewed", "ad_impression"],
    defaultFeatures: ["push"],
    revenueEvent: "ad_impression",
    activationCandidates: ["content_viewed"],
    northStarCandidates: ["content_viewed"],
    userProperties: ["content_preferences"],
    keywords: ["ads", "advertising", "ad-supported", "news", "media", "publisher"],
  },
  other: {
    events: ["feature_used"],
    defaultFeatures: ["push"],
    revenueEvent: null,
    activationCandidates: ["feature_used"],
    northStarCandidates: ["feature_used"],
    userProperties: [],
    keywords: [],
  },
};

/** Events each product feature brings in, regardless of model. */
export const FEATURE_EVENTS: Record<Feature, string[]> = {
  search: ["search_performed"],
  cart_checkout: ["product_viewed", "product_added_to_cart", "cart_viewed", "checkout_started"],
  subscriptions: ["paywall_viewed", "subscription_started", "subscription_renewed", "subscription_cancelled", "subscription_expired"],
  bookings: ["booking_started", "booking_completed", "booking_cancelled"],
  payments_wallet: ["deposit_completed", "transfer_completed"],
  messaging: ["message_sent"],
  user_content: ["content_created", "content_viewed"],
  reviews: ["review_submitted"],
  referrals: ["referral_link_shared", "referral_completed"],
  rewards: ["reward_earned", "reward_redeemed"],
  push: ["push_opened"],
  deep_links: ["deep_link_opened"],
  wishlist: ["wishlist_added"],
  onboarding: ["onboarding_started", "onboarding_completed"],
};

/**
 * Natural-language journey phrases → events. Matching is case-insensitive on
 * whole phrases. Order in the user's text is preserved in the plan.
 */
export const JOURNEY_PHRASES: { pattern: RegExp; events: string[]; onlyFor?: BusinessModel[] }[] = [
  { pattern: /\b(register|registers|registration|sign(s|ed)? ?up|create(s)? an? account)\b/i, events: ["signup_started", "signup_completed"] },
  { pattern: /\b(log ?in|logs in|sign(s)? in)\b/i, events: ["login_completed"] },
  { pattern: /\bonboard(ing)?\b/i, events: ["onboarding_started", "onboarding_completed"] },
  { pattern: /\bsearch(es|ing)?\b/i, events: ["search_performed"] },
  { pattern: /\b(browse|browses|browsing)\b/i, events: ["product_list_viewed", "product_viewed"], onlyFor: ["ecommerce"] },
  { pattern: /\b(browse|browses|browsing)\b/i, events: ["listing_viewed"], onlyFor: ["marketplace"] },
  { pattern: /\b(view|views|see|sees|open|opens) (a |the )?products?\b/i, events: ["product_viewed"] },
  { pattern: /\badds? (products?|items?|meals?|it|them)? ?to (the )?(cart|basket|bag)\b/i, events: ["product_added_to_cart", "cart_viewed"] },
  { pattern: /\b(checkout|check out|checks out)\b/i, events: ["checkout_started"] },
  { pattern: /\b(pay|pays|payment|purchase|purchases|buy|buys)\b/i, events: ["purchase_completed"] },
  { pattern: /\b(choose|chooses|pick|picks|select|selects) (a )?(restaurant|store|shop)s?\b/i, events: ["vendor_viewed"], onlyFor: ["delivery"] },
  { pattern: /\bmenus?\b/i, events: ["menu_viewed"], onlyFor: ["delivery"] },
  { pattern: /\b(order|orders|ordering)\b/i, events: ["order_completed"], onlyFor: ["delivery", "ecommerce"] },
  { pattern: /\bdeliver(ed|y)\b/i, events: ["order_delivered"], onlyFor: ["delivery"] },
  { pattern: /\b(subscribe|subscribes|subscription)\b/i, events: ["paywall_viewed", "subscription_started"] },
  { pattern: /\bfree trial|\btrials?\b/i, events: ["trial_started"] },
  { pattern: /\b(book|books|booking|reserve|reserves|reservation)\b/i, events: ["booking_started", "booking_completed"] },
  { pattern: /\b(list|lists|post|posts|sell|sells) (a |an |their )?(cars?|items?|products?|listings?|ads?)\b/i, events: ["listing_created", "listing_published"], onlyFor: ["marketplace"] },
  { pattern: /\b(contact|contacts|message|messages|chat|chats|call|calls) (with )?(the )?sellers?\b/i, events: ["message_started"], onlyFor: ["marketplace"] },
  { pattern: /\b(offer|offers|negotiate|negotiates)\b/i, events: ["offer_created"], onlyFor: ["marketplace"] },
  { pattern: /\b(kyc|verify|verifies|verification|identity check)\b/i, events: ["kyc_started", "kyc_completed"], onlyFor: ["fintech"] },
  { pattern: /\b(deposit|deposits|top ?up|tops up|add money|fund)\b/i, events: ["deposit_completed"], onlyFor: ["fintech"] },
  { pattern: /\b(transfer|transfers|send money|sends money)\b/i, events: ["transfer_completed"], onlyFor: ["fintech"] },
  { pattern: /\b(enrol|enroll|enrolls|enrols|start(s)? a course)\b/i, events: ["course_started"], onlyFor: ["edtech"] },
  { pattern: /\blessons?\b/i, events: ["lesson_started", "lesson_completed"], onlyFor: ["edtech"] },
  { pattern: /\b(appointment|consultation)s?\b/i, events: ["appointment_booked"], onlyFor: ["healthcare"] },
  { pattern: /\blevels?\b/i, events: ["level_started", "level_completed"], onlyFor: ["gaming"] },
  { pattern: /\btutorial\b/i, events: ["tutorial_completed"], onlyFor: ["gaming"] },
  { pattern: /\b(follow|follows)\b/i, events: ["user_followed"], onlyFor: ["social"] },
  { pattern: /\b(post|posts|upload|uploads|create content)\b/i, events: ["content_created"], onlyFor: ["social"] },
  { pattern: /\b(review|reviews|rate|rates|rating)\b/i, events: ["review_submitted"] },
  { pattern: /\b(refer|refers|referral|invite friends?)\b/i, events: ["referral_link_shared", "referral_completed"] },
  { pattern: /\b(points|rewards?|cashback|loyalty)\b/i, events: ["reward_earned"] },
  { pattern: /\b(invite|invites) (their )?(team|teammates|colleagues)\b/i, events: ["teammate_invited"] },
  { pattern: /\b(quote|enquiry|inquiry|lead form)\b/i, events: ["lead_submitted"], onlyFor: ["lead_generation"] },
  { pattern: /\bpush notifications?\b/i, events: ["push_opened"] },
  { pattern: /\b(deep ?links?|universal links?|app links?)\b/i, events: ["deep_link_opened"] },
];

/** Per-model replacements so generic phrases map to the model's own events. */
export const MODEL_SUBSTITUTIONS: Partial<Record<BusinessModel, Record<string, string>>> = {
  healthcare: { booking_started: "appointment_booking_started", booking_completed: "appointment_booked", booking_cancelled: "appointment_cancelled" },
  marketplace: { product_viewed: "listing_viewed" },
  gaming: { purchase_completed: "in_app_purchase_completed" },
};

// ── User properties ─────────────────────────────────────────────────────────
export interface UserPropertyDefinition {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array" | "datetime";
  description: string;
  source: "mobile_sdk" | "backend" | "both" | "automatic" | "computed";
  reason: string;
}

const up = (name: string, type: UserPropertyDefinition["type"], source: UserPropertyDefinition["source"], description: string, reason: string): UserPropertyDefinition => ({ name, type, source, description, reason });

export const USER_PROPERTY_LIBRARY: Record<string, UserPropertyDefinition> = Object.fromEntries(
  [
    up("country", "string", "automatic", msg("ISO country (from device locale / IP at ingestion)."), msg("Market-level analysis across your countries.")),
    up("city", "string", "backend", msg("City the user is served in."), msg("City-level operations and targeting.")),
    up("language", "string", "automatic", msg("Preferred language (e.g. ar, en)."), msg("Arabic vs English messaging and UX analysis.")),
    up("platform", "string", "automatic", msg("ios / android."), msg("Platform breakdowns.")),
    up("app_version", "string", "automatic", msg("Latest app version seen."), msg("Version adoption and regressions.")),
    up("signup_date", "datetime", "backend", msg("When the account was created."), msg("Cohorts by signup date.")),
    up("account_type", "string", "backend", msg("Account type."), msg("Segment behaviour by account type.")),
    up("customer_type", "string", "backend", msg("Customer segment (e.g. regular, vip)."), msg("Targeting and reporting by segment.")),
    up("plan", "string", "backend", msg("Current plan."), msg("Plan-level conversion and churn.")),
    up("subscription_status", "string", "backend", msg("trialing / active / cancelled / expired."), msg("Lifecycle automation for subscribers.")),
    up("subscription_start_date", "datetime", "backend", msg("First paid subscription date."), msg("Subscriber tenure cohorts.")),
    up("trial_status", "string", "backend", msg("none / active / converted / expired."), msg("Trial conversion automation.")),
    up("lifecycle_stage", "string", "computed", msg("new / activated / engaged / at_risk / churned."), msg("Computed from events; drives lifecycle automation.")),
    up("first_purchase_date", "datetime", "computed", msg("Date of first purchase."), msg("Time-to-first-purchase and repeat analysis.")),
    up("last_purchase_date", "datetime", "computed", msg("Date of latest purchase."), msg("Win-back audiences.")),
    up("total_revenue", "number", "computed", msg("Lifetime revenue in the app's default currency."), msg("LTV segments.")),
    up("order_count", "integer", "computed", msg("Number of completed orders."), msg("Repeat-buyer segments.")),
    up("first_order_date", "datetime", "computed", msg("Date of first order."), msg("Cohorts by first order.")),
    up("last_order_date", "datetime", "computed", msg("Date of latest order."), msg("Reorder nudges.")),
    up("preferred_category", "string", "computed", msg("Most purchased / viewed category."), msg("Personalised campaigns.")),
    up("preferred_cuisine", "string", "computed", msg("Most ordered cuisine."), msg("Personalised campaigns.")),
    up("buyer_or_seller", "string", "backend", msg("buyer / seller / both."), msg("Two-sided marketplace analysis.")),
    up("seller_category", "string", "backend", msg("What the seller lists."), msg("Supply analysis by category.")),
    up("listing_count", "integer", "computed", msg("Active listings."), msg("Seller health.")),
    up("verification_status", "string", "backend", msg("unverified / pending / verified / rejected."), msg("KYC funnel and automation.")),
    up("first_deposit_date", "datetime", "computed", msg("First funded date."), msg("Activation cohorts.")),
    up("funded", "boolean", "computed", msg("Has ever deposited."), msg("Activation audiences.")),
    up("student_level", "string", "backend", msg("Learner level."), msg("Content recommendations.")),
    up("learning_stage", "string", "computed", msg("e.g. exploring / enrolled / progressing / completed."), msg("Lifecycle messaging.")),
    up("courses_count", "integer", "computed", msg("Courses enrolled."), msg("Engagement depth.")),
    up("preferred_subject", "string", "computed", msg("Most studied subject."), msg("Recommendations.")),
    up("patient_type", "string", "backend", msg("e.g. new / returning."), msg("Follow-up automation (no health data).")),
    up("appointment_count", "integer", "computed", msg("Completed appointments."), msg("Retention.")),
    up("player_level", "integer", "mobile_sdk", msg("Current level."), msg("Progression segments.")),
    up("payer_status", "string", "computed", msg("non_payer / payer / whale."), msg("Monetisation segments.")),
    up("followers_count", "integer", "backend", msg("Followers."), msg("Creator segments.")),
    up("following_count", "integer", "backend", msg("Following."), msg("Graph density.")),
    up("creator_status", "boolean", "computed", msg("Has created content."), msg("Creator activation.")),
    up("workspace_role", "string", "backend", msg("Role in the workspace."), msg("Admin vs member behaviour.")),
    up("company_size", "string", "backend", msg("Company size band."), msg("Account segmentation.")),
    up("booking_count", "integer", "computed", msg("Completed bookings."), msg("Repeat behaviour.")),
    up("last_booking_date", "datetime", "computed", msg("Latest booking."), msg("Rebooking nudges.")),
    up("lead_status", "string", "backend", msg("CRM status."), msg("Lead-quality reporting.")),
    up("interest", "string", "backend", msg("What the lead asked about."), msg("Targeting.")),
    up("content_preferences", "array", "computed", msg("Topics consumed most."), msg("Personalisation.")),
    up("user_type", "string", "backend", msg("Which kind of user this is."), msg("Separate funnels per user type.")),
    up("referral_code", "string", "backend", msg("The user's own referral code."), msg("Referral attribution.")),
    up("reward_points_balance", "integer", "backend", msg("Current points balance."), msg("Loyalty automation.")),
    up("push_opt_in", "boolean", "automatic", msg("Push permission granted."), msg("Reachability for automation.")),
    up("marketing_opt_in", "boolean", "backend", msg("Marketing consent."), msg("Required before marketing automation.")),
  ].map((u) => [u.name, u]),
);

export const BASE_USER_PROPERTIES = ["country", "language", "platform", "app_version", "signup_date", "lifecycle_stage", "push_opt_in", "marketing_opt_in"];

// ── Attribution ─────────────────────────────────────────────────────────────
export const ATTRIBUTION_CHANNELS = ["meta", "google", "tiktok", "snapchat", "x", "influencers", "organic", "referral", "qr", "deep_links", "email_sms", "other"] as const;
export type AttributionChannel = (typeof ATTRIBUTION_CHANNELS)[number];

export const CHANNEL_LABELS: Record<AttributionChannel, string> = {
  meta: msg("Meta (Facebook / Instagram)"), google: msg("Google Ads"), tiktok: "TikTok", snapchat: "Snapchat", x: msg("X (Twitter)"),
  influencers: msg("Influencers"), organic: msg("Organic / App Store search"), referral: msg("Referral programme"), qr: msg("QR codes / offline"),
  deep_links: msg("Deep links (web → app)"), email_sms: msg("Email / SMS / WhatsApp"), other: msg("Other"),
};

export const STANDARD_ATTRIBUTION_PARAMETERS = [
  "source", "medium", "campaign", "campaign_id", "ad_group", "ad_group_id", "creative", "creative_id",
  "click_id", "referrer", "landing_page", "touchpoint_timestamp",
];

export const CHANNEL_RULES: Record<AttributionChannel, { clickIdParam: string | null; parameters: string[]; notes: string }> = {
  meta: { clickIdParam: "fbclid", parameters: STANDARD_ATTRIBUTION_PARAMETERS, notes: msg("Use utm_source=meta and pass campaign / ad set / ad ids via URL macros ({{campaign.id}}, {{adset.id}}, {{ad.id}}). Install attribution for paid social also needs SKAdNetwork / AEM on iOS and an MMP or the native SDK on Android.") },
  google: { clickIdParam: "gclid", parameters: STANDARD_ATTRIBUTION_PARAMETERS, notes: msg("Enable auto-tagging (gclid; gbraid/wbraid on iOS). App campaigns report installs through Google's own SDK integrations or an MMP.") },
  tiktok: { clickIdParam: "ttclid", parameters: STANDARD_ATTRIBUTION_PARAMETERS, notes: msg("Use TikTok URL macros (__CAMPAIGN_ID__, __AID__, __CID__) in tracking links.") },
  snapchat: { clickIdParam: "ScCid", parameters: STANDARD_ATTRIBUTION_PARAMETERS, notes: msg("Use Snapchat macros ({{campaign.id}}, {{adSet.id}}, {{ad.id}}). Snapchat is strong in KSA: keep its campaign naming consistent.") },
  x: { clickIdParam: "twclid", parameters: STANDARD_ATTRIBUTION_PARAMETERS, notes: msg("Use UTMs plus twclid.") },
  influencers: { clickIdParam: null, parameters: ["source", "medium", "campaign", "creative", "referrer", "landing_page", "touchpoint_timestamp"], notes: msg("Give each influencer a unique link (utm_source=influencer, utm_campaign=<handle>) and, where possible, a unique promo code captured as coupon_code on the conversion event.") },
  organic: { clickIdParam: null, parameters: ["source", "referrer", "touchpoint_timestamp"], notes: msg("Installs without a touchpoint are organic. Store-search attribution needs Apple Search Ads / Play install referrer.") },
  referral: { clickIdParam: null, parameters: ["source", "medium", "campaign", "referrer", "touchpoint_timestamp"], notes: msg("Referral links carry referral_code; referral_completed credits the referrer.") },
  qr: { clickIdParam: null, parameters: ["source", "medium", "campaign", "creative", "landing_page", "touchpoint_timestamp"], notes: msg("One QR per placement: utm_medium=qr, utm_campaign=<placement>.") },
  deep_links: { clickIdParam: null, parameters: ["source", "medium", "campaign", "landing_page", "referrer", "touchpoint_timestamp"], notes: msg("Deep links must forward UTM parameters into the app so deep_link_opened carries them.") },
  email_sms: { clickIdParam: null, parameters: ["source", "medium", "campaign", "creative", "touchpoint_timestamp"], notes: msg("Tag every link (utm_medium=email|sms|whatsapp).") },
  other: { clickIdParam: null, parameters: ["source", "medium", "campaign", "touchpoint_timestamp"], notes: msg("Tag links with at least utm_source, utm_medium and utm_campaign.") },
};
