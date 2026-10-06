/**
 * Property library. Events reference property sets by key, so a property like
 * `currency` is defined once with one type and description everywhere.
 */
export type PropertyType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "currency" | "datetime";

export interface PropertySpec {
  name: string;
  type: PropertyType;
  required: boolean;
  description: string;
  example?: unknown;
  allowedValues?: string[];
}

const p = (name: string, type: PropertyType, description: string, example?: unknown, extra: Partial<PropertySpec> = {}): PropertySpec => ({
  name,
  type,
  required: false,
  description,
  example,
  ...extra,
});
const req = (spec: PropertySpec): PropertySpec => ({ ...spec, required: true });

// Shared atoms
const currency = req(p("currency", "currency", "ISO 4217 code of all amounts on this event.", "SAR"));
const productId = req(p("product_id", "string", "Your product or SKU id.", "SKU-123"));
const price = p("price", "number", "Unit price in `currency`.", 299);

export const PROPERTY_SETS = {
  screen: [req(p("screen_name", "string", "Human-readable screen name.", "Home")), p("screen_class", "string", "Native class / route name.", "HomeActivity")],
  app_opened: [p("from_background", "boolean", "Whether the app resumed from background.", false)],
  app_updated: [p("previous_version", "string", "App version before the update.", "1.4.0")],
  deep_link: [req(p("url", "string", "The opened deep link / universal link.", "myapp://product/123")), p("source", "string", "utm_source or referring app.", "tiktok"), p("campaign", "string", "Campaign name.", "ramadan_sale")],
  push_opened: [p("campaign_id", "string", "Platform campaign or automation id.", "cmp_123"), p("message_id", "string", "Message id.", "msg_456")],
  signup: [req(p("method", "string", "How the user signed up.", "phone", { allowedValues: ["email", "phone", "google", "apple", "facebook", "other"] })), p("referral_code", "string", "Referral code used, if any.", "AHMED10")],
  login: [req(p("method", "string", "How the user signed in.", "phone", { allowedValues: ["email", "phone", "google", "apple", "facebook", "biometric", "other"] }))],
  onboarding_step: [p("step_count", "integer", "Number of onboarding steps completed.", 3)],
  search: [req(p("query", "string", "The search text.", "running shoes")), p("results_count", "integer", "Number of results shown.", 24), p("category", "string", "Category filter, if any.", "shoes")],
  product: [productId, p("product_name", "string", "Product name.", "Air Runner"), p("category", "string", "Product category.", "shoes"), price, p("currency", "currency", "ISO 4217 code of price.", "SAR"), p("brand", "string", "Brand.", "Acme"), p("availability", "string", "Stock state.", "in_stock", { allowedValues: ["in_stock", "out_of_stock", "preorder"] })],
  product_list: [p("list_name", "string", "Which list or category page.", "Best sellers"), p("category", "string", "Category.", "shoes")],
  cart_item: [productId, p("product_name", "string", "Product name.", "Air Runner"), req(p("quantity", "integer", "Quantity added or removed.", 1)), price, p("currency", "currency", "ISO 4217 code of price.", "SAR"), p("cart_id", "string", "Cart id.", "cart_789")],
  cart: [p("cart_id", "string", "Cart id.", "cart_789"), req(p("cart_value", "number", "Cart total in `currency`.", 598)), currency, req(p("item_count", "integer", "Items in cart.", 2))],
  checkout: [p("checkout_id", "string", "Checkout id.", "chk_1"), req(p("value", "number", "Checkout total in `currency`.", 598)), currency, req(p("item_count", "integer", "Items being purchased.", 2)), p("coupon_code", "string", "Coupon applied.", "WELCOME10")],
  purchase: [
    req(p("transaction_id", "string", "Unique payment / transaction id. Used to de-duplicate revenue.", "txn_9f8e7d")),
    p("order_id", "string", "Your order id.", "ORD-1001"),
    req(p("revenue", "number", "Amount earned, in `currency`, after discounts.", 549)),
    currency,
    p("discount", "number", "Discount amount.", 50),
    p("tax", "number", "Tax amount.", 0),
    p("shipping", "number", "Shipping / delivery fee.", 0),
    p("payment_method", "string", "Payment method.", "card", { allowedValues: ["card", "apple_pay", "google_pay", "mada", "stc_pay", "cash_on_delivery", "wallet", "bnpl", "bank_transfer", "other"] }),
    p("product_count", "integer", "Number of items.", 2),
    p("coupon_code", "string", "Coupon used.", "WELCOME10"),
  ],
  refund: [req(p("transaction_id", "string", "Original transaction id.", "txn_9f8e7d")), req(p("refund_amount", "number", "Refunded amount.", 549)), currency, p("reason", "string", "Refund reason.", "damaged")],
  subscription: [
    req(p("subscription_id", "string", "Subscription id from your billing system.", "sub_123")),
    req(p("plan_id", "string", "Plan id.", "premium_monthly")),
    p("plan_name", "string", "Plan display name.", "Premium"),
    req(p("price", "number", "Recurring price in `currency`.", 29)),
    currency,
    req(p("billing_period", "string", "Billing period.", "monthly", { allowedValues: ["weekly", "monthly", "quarterly", "yearly", "lifetime"] })),
    p("trial", "boolean", "Whether this started with a trial.", false),
    p("trial_days", "integer", "Trial length in days.", 7),
  ],
  subscription_ref: [req(p("subscription_id", "string", "Subscription id.", "sub_123")), req(p("plan_id", "string", "Plan id.", "premium_monthly")), p("reason", "string", "Cancellation / expiry reason.", "too_expensive")],
  paywall: [p("paywall_id", "string", "Which paywall / offer.", "onboarding_paywall"), p("placement", "string", "Where it was shown.", "after_onboarding")],
  trial: [req(p("plan_id", "string", "Plan being trialled.", "premium_monthly")), req(p("trial_days", "integer", "Trial length.", 7))],
  vendor: [req(p("vendor_id", "string", "Restaurant / store id.", "rest_42")), p("vendor_name", "string", "Restaurant / store name.", "Shawarma House"), p("cuisine", "string", "Cuisine or store type.", "lebanese"), p("rating", "number", "Average rating shown.", 4.6), p("delivery_fee", "number", "Delivery fee shown.", 9), p("eta_minutes", "integer", "Estimated delivery time.", 35)],
  menu: [req(p("vendor_id", "string", "Restaurant / store id.", "rest_42")), p("menu_category", "string", "Menu section.", "wraps")],
  order: [
    req(p("order_id", "string", "Order id.", "ORD-1001")),
    req(p("transaction_id", "string", "Payment / transaction id.", "txn_9f8e7d")),
    p("vendor_id", "string", "Restaurant / store id.", "rest_42"),
    req(p("revenue", "number", "Order value earned, in `currency`.", 86)),
    currency,
    req(p("item_count", "integer", "Items in the order.", 3)),
    p("delivery_fee", "number", "Delivery fee.", 9),
    p("discount", "number", "Discount.", 10),
    p("payment_method", "string", "Payment method.", "cash_on_delivery"),
    p("coupon_code", "string", "Coupon used.", "FREEDEL"),
  ],
  order_ref: [req(p("order_id", "string", "Order id.", "ORD-1001")), p("reason", "string", "Reason, if cancelled.", "late_delivery"), p("cancelled_by", "string", "Who cancelled.", "customer", { allowedValues: ["customer", "vendor", "courier", "system"] })],
  delivery: [req(p("order_id", "string", "Order id.", "ORD-1001")), p("delivery_minutes", "integer", "Minutes from order to delivery.", 32)],
  review: [req(p("target_id", "string", "What was reviewed (order, product, listing, provider id).", "ORD-1001")), req(p("rating", "integer", "Star rating 1–5.", 5)), p("has_text", "boolean", "Whether a written review was included.", true)],
  listing: [req(p("listing_id", "string", "Listing id.", "lst_77")), p("category", "string", "Listing category.", "cars"), p("price", "number", "Asking price.", 85000), p("currency", "currency", "ISO 4217 code of price.", "SAR"), p("seller_id", "string", "Seller's user id.", "user_456")],
  listing_create: [req(p("listing_id", "string", "Listing id.", "lst_77")), req(p("category", "string", "Listing category.", "cars")), p("price", "number", "Asking price.", 85000), p("currency", "currency", "ISO 4217 code of price.", "SAR"), p("photo_count", "integer", "Photos attached.", 8)],
  conversation: [req(p("conversation_id", "string", "Conversation id.", "conv_5")), p("listing_id", "string", "Related listing.", "lst_77"), p("recipient_role", "string", "Who receives the message.", "seller")],
  offer: [req(p("offer_id", "string", "Offer id.", "off_3")), req(p("listing_id", "string", "Listing id.", "lst_77")), req(p("amount", "number", "Offer amount.", 80000)), currency],
  marketplace_purchase: [
    req(p("transaction_id", "string", "Transaction id.", "txn_9f8e7d")),
    req(p("listing_id", "string", "Listing id.", "lst_77")),
    p("seller_id", "string", "Seller's user id.", "user_456"),
    req(p("revenue", "number", "Your take (commission / fee) in `currency`.", 1700)),
    p("gmv", "number", "Gross transaction value.", 85000),
    currency,
    p("payment_method", "string", "Payment method.", "bank_transfer"),
  ],
  booking_search: [p("location", "string", "Searched location.", "Riyadh"), p("check_in", "datetime", "Requested date/time.", "2026-11-02T18:00:00Z"), p("guests", "integer", "Party size.", 2)],
  bookable: [req(p("item_id", "string", "Service / property / slot id.", "svc_12")), p("item_name", "string", "Display name.", "Deep tissue massage"), p("price", "number", "Price.", 250), p("currency", "currency", "ISO 4217 code of price.", "SAR")],
  booking: [
    req(p("booking_id", "string", "Booking id.", "bk_301")),
    req(p("item_id", "string", "Booked service / property id.", "svc_12")),
    req(p("booking_date", "datetime", "When the booking is for.", "2026-11-02T18:00:00Z")),
    req(p("revenue", "number", "Amount earned, in `currency`.", 250)),
    currency,
    p("transaction_id", "string", "Payment id, if paid.", "txn_77"),
  ],
  booking_ref: [req(p("booking_id", "string", "Booking id.", "bk_301")), p("reason", "string", "Reason.", "schedule_conflict"), p("cancelled_by", "string", "Who cancelled.", "customer")],
  kyc: [p("verification_level", "string", "Level being verified.", "basic"), p("method", "string", "Method.", "national_id")],
  kyc_failed: [p("verification_level", "string", "Level.", "basic"), req(p("failure_reason", "string", "Coarse reason code (never raw documents).", "document_unreadable"))],
  account: [req(p("account_id", "string", "Account / wallet id.", "acc_1")), p("account_type", "string", "Account type.", "personal")],
  money_movement: [req(p("transaction_id", "string", "Transaction id.", "txn_55")), req(p("amount", "number", "Amount in `currency`.", 500)), currency, p("method", "string", "Funding / transfer method.", "card"), p("fee", "number", "Fee you earned, if any.", 2.5)],
  course: [req(p("course_id", "string", "Course id.", "crs_8")), p("course_name", "string", "Course name.", "Arabic for beginners"), p("category", "string", "Subject.", "languages"), p("level", "string", "Level.", "beginner")],
  lesson: [req(p("course_id", "string", "Course id.", "crs_8")), req(p("lesson_id", "string", "Lesson id.", "les_3")), p("lesson_number", "integer", "Lesson position in the course.", 3), p("duration_seconds", "integer", "Time spent.", 540)],
  provider: [req(p("provider_id", "string", "Doctor / clinic / provider id.", "prv_9")), p("specialty", "string", "Specialty (broad category only).", "dermatology")],
  appointment: [req(p("appointment_id", "string", "Appointment id.", "apt_4")), req(p("provider_id", "string", "Provider id.", "prv_9")), p("appointment_type", "string", "Visit type.", "video", { allowedValues: ["in_person", "video", "chat", "home_visit"] }), p("revenue", "number", "Amount earned, if paid.", 200), p("currency", "currency", "ISO 4217 code.", "SAR")],
  appointment_ref: [req(p("appointment_id", "string", "Appointment id.", "apt_4")), p("reason", "string", "Reason.", "rescheduled")],
  level: [req(p("level", "integer", "Level number.", 4)), p("level_name", "string", "Level name.", "Desert run"), p("score", "number", "Score.", 1200), p("duration_seconds", "integer", "Time spent.", 95)],
  iap: [req(p("transaction_id", "string", "Store transaction id.", "GPA.1234-5678")), req(p("product_id", "string", "Store product id.", "coins_500")), req(p("revenue", "number", "Amount earned, in `currency`.", 19)), currency, p("store", "string", "Store.", "google_play", { allowedValues: ["app_store", "google_play", "huawei", "web"] })],
  ad: [req(p("ad_unit", "string", "Ad unit / placement.", "rewarded_level_end")), p("ad_network", "string", "Network.", "admob"), p("revenue", "number", "Estimated ad revenue, if reported.", 0.002), p("currency", "currency", "ISO 4217 code.", "USD")],
  achievement: [req(p("achievement_id", "string", "Achievement id.", "first_win"))],
  content: [req(p("content_id", "string", "Content id.", "post_1")), p("content_type", "string", "Content type.", "video")],
  content_create: [req(p("content_id", "string", "Content id.", "post_1")), req(p("content_type", "string", "Content type.", "video")), p("has_media", "boolean", "Includes photo/video.", true)],
  follow: [req(p("target_user_id", "string", "Followed user id.", "user_789"))],
  message: [req(p("conversation_id", "string", "Conversation id.", "conv_5")), p("message_type", "string", "Text / image / voice.", "text")],
  share: [req(p("content_id", "string", "Shared content id.", "post_1")), p("channel", "string", "Share target.", "whatsapp")],
  workspace: [req(p("workspace_id", "string", "Workspace / team id.", "ws_1"))],
  invite: [p("workspace_id", "string", "Workspace id.", "ws_1"), p("invitee_count", "integer", "People invited.", 2), p("channel", "string", "How the invite was sent.", "email")],
  feature: [req(p("feature_name", "string", "Feature used.", "export_report")), p("workspace_id", "string", "Workspace id.", "ws_1")],
  lead_form: [req(p("form_name", "string", "Which form.", "car_finance_quote"))],
  lead: [req(p("lead_id", "string", "Lead id.", "lead_31")), req(p("form_name", "string", "Which form.", "car_finance_quote")), p("lead_type", "string", "Lead type.", "finance")],
  lead_qualified: [req(p("lead_id", "string", "Lead id.", "lead_31")), p("value", "number", "Expected value, if known.", 400), p("currency", "currency", "ISO 4217 code.", "SAR")],
  referral_share: [p("channel", "string", "Share channel.", "whatsapp"), req(p("referral_code", "string", "The user's referral code.", "AHMED10"))],
  referral: [req(p("referral_code", "string", "Code used.", "AHMED10")), req(p("referrer_user_id", "string", "Referrer's user id.", "user_456"))],
  reward: [req(p("reward_id", "string", "Reward / rule id.", "rw_1")), req(p("points", "integer", "Points earned or spent.", 100)), p("reward_type", "string", "Reward type.", "cashback")],
  wishlist: [productId, p("product_name", "string", "Product name.", "Air Runner")],
} satisfies Record<string, PropertySpec[]>;

export type PropertySetKey = keyof typeof PROPERTY_SETS;

/**
 * Names that describe an action, not a person. Sending them as user
 * properties overwrites history with the latest value (event vs user property
 * intelligence, docs/implementation-engine.md §30).
 */
export const VOLATILE_PROPERTY_PATTERNS: RegExp[] = [
  /^(transaction|order|cart|checkout|booking|appointment|offer|listing|product|message|conversation|content|lesson)_id$/,
  /^(revenue|amount|price|quantity|cart_value|value|discount|tax|shipping|delivery_fee)$/,
  /^(query|search_query|screen_name|url|coupon_code|payment_method|rating|score)$/,
  /^last_(viewed|clicked|searched)_/,
];

export function isVolatilePropertyName(name: string): boolean {
  return VOLATILE_PROPERTY_PATTERNS.some((r) => r.test(name));
}
