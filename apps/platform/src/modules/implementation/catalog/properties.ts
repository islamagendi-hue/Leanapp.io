/**
 * Property library. Events reference property sets by key, so a property like
 * `currency` is defined once with one type and description everywhere.
 */
import { msg } from "@/i18n/translate";
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
const currency = req(p("currency", "currency", msg("ISO 4217 code of all amounts on this event."), "SAR"));
const productId = req(p("product_id", "string", msg("Your product or SKU id."), "SKU-123"));
const price = p("price", "number", msg("Unit price in `currency`."), 299);

export const PROPERTY_SETS = {
  screen: [req(p("screen_name", "string", msg("Human-readable screen name."), "Home")), p("screen_class", "string", msg("Native class / route name."), "HomeActivity")],
  app_opened: [p("from_background", "boolean", msg("Whether the app resumed from background."), false)],
  app_updated: [p("previous_version", "string", msg("App version before the update."), "1.4.0")],
  deep_link: [req(p("url", "string", msg("The opened deep link / universal link."), "myapp://product/123")), p("source", "string", msg("utm_source or referring app."), "tiktok"), p("campaign", "string", msg("Campaign name."), "ramadan_sale")],
  push_opened: [p("campaign_id", "string", msg("Platform campaign or automation id."), "cmp_123"), p("message_id", "string", msg("Message id."), "msg_456")],
  signup: [req(p("method", "string", msg("How the user signed up."), "phone", { allowedValues: ["email", "phone", "google", "apple", "facebook", "other"] })), p("referral_code", "string", msg("Referral code used, if any."), "AHMED10")],
  login: [req(p("method", "string", msg("How the user signed in."), "phone", { allowedValues: ["email", "phone", "google", "apple", "facebook", "biometric", "other"] }))],
  onboarding_step: [p("step_count", "integer", msg("Number of onboarding steps completed."), 3)],
  search: [req(p("query", "string", msg("The search text."), "running shoes")), p("results_count", "integer", msg("Number of results shown."), 24), p("category", "string", msg("Category filter, if any."), "shoes")],
  product: [productId, p("product_name", "string", msg("Product name."), "Air Runner"), p("category", "string", msg("Product category."), "shoes"), price, p("currency", "currency", msg("ISO 4217 code of price."), "SAR"), p("brand", "string", msg("Brand."), "Acme"), p("availability", "string", msg("Stock state."), "in_stock", { allowedValues: ["in_stock", "out_of_stock", "preorder"] })],
  product_list: [p("list_name", "string", msg("Which list or category page."), "Best sellers"), p("category", "string", msg("Category."), "shoes")],
  cart_item: [productId, p("product_name", "string", msg("Product name."), "Air Runner"), req(p("quantity", "integer", msg("Quantity added or removed."), 1)), price, p("currency", "currency", msg("ISO 4217 code of price."), "SAR"), p("cart_id", "string", msg("Cart id."), "cart_789")],
  cart: [p("cart_id", "string", msg("Cart id."), "cart_789"), req(p("cart_value", "number", msg("Cart total in `currency`."), 598)), currency, req(p("item_count", "integer", msg("Items in cart."), 2))],
  checkout: [p("checkout_id", "string", msg("Checkout id."), "chk_1"), req(p("value", "number", msg("Checkout total in `currency`."), 598)), currency, req(p("item_count", "integer", msg("Items being purchased."), 2)), p("coupon_code", "string", msg("Coupon applied."), "WELCOME10")],
  purchase: [
    req(p("transaction_id", "string", msg("Unique payment / transaction id. Used to de-duplicate revenue."), "txn_9f8e7d")),
    p("order_id", "string", msg("Your order id."), "ORD-1001"),
    req(p("revenue", "number", msg("Amount earned, in `currency`, after discounts."), 549)),
    currency,
    p("discount", "number", msg("Discount amount."), 50),
    p("tax", "number", msg("Tax amount."), 0),
    p("shipping", "number", msg("Shipping / delivery fee."), 0),
    p("payment_method", "string", msg("Payment method."), "card", { allowedValues: ["card", "apple_pay", "google_pay", "mada", "stc_pay", "cash_on_delivery", "wallet", "bnpl", "bank_transfer", "other"] }),
    p("product_count", "integer", msg("Number of items."), 2),
    p("coupon_code", "string", msg("Coupon used."), "WELCOME10"),
  ],
  refund: [req(p("transaction_id", "string", msg("Original transaction id."), "txn_9f8e7d")), req(p("refund_amount", "number", msg("Refunded amount."), 549)), currency, p("reason", "string", msg("Refund reason."), "damaged")],
  subscription: [
    req(p("subscription_id", "string", msg("Subscription id from your billing system."), "sub_123")),
    req(p("plan_id", "string", msg("Plan id."), "premium_monthly")),
    p("plan_name", "string", msg("Plan display name."), "Premium"),
    req(p("price", "number", msg("Recurring price in `currency`."), 29)),
    currency,
    req(p("billing_period", "string", msg("Billing period."), "monthly", { allowedValues: ["weekly", "monthly", "quarterly", "yearly", "lifetime"] })),
    p("trial", "boolean", msg("Whether this started with a trial."), false),
    p("trial_days", "integer", msg("Trial length in days."), 7),
  ],
  subscription_ref: [req(p("subscription_id", "string", msg("Subscription id."), "sub_123")), req(p("plan_id", "string", msg("Plan id."), "premium_monthly")), p("reason", "string", msg("Cancellation / expiry reason."), "too_expensive")],
  paywall: [p("paywall_id", "string", msg("Which paywall / offer."), "onboarding_paywall"), p("placement", "string", msg("Where it was shown."), "after_onboarding")],
  trial: [req(p("plan_id", "string", msg("Plan being trialled."), "premium_monthly")), req(p("trial_days", "integer", msg("Trial length."), 7))],
  vendor: [req(p("vendor_id", "string", msg("Restaurant / store id."), "rest_42")), p("vendor_name", "string", msg("Restaurant / store name."), "Shawarma House"), p("cuisine", "string", msg("Cuisine or store type."), "lebanese"), p("rating", "number", msg("Average rating shown."), 4.6), p("delivery_fee", "number", msg("Delivery fee shown."), 9), p("eta_minutes", "integer", msg("Estimated delivery time."), 35)],
  menu: [req(p("vendor_id", "string", msg("Restaurant / store id."), "rest_42")), p("menu_category", "string", msg("Menu section."), "wraps")],
  order: [
    req(p("order_id", "string", msg("Order id."), "ORD-1001")),
    req(p("transaction_id", "string", msg("Payment / transaction id."), "txn_9f8e7d")),
    p("vendor_id", "string", msg("Restaurant / store id."), "rest_42"),
    req(p("revenue", "number", msg("Order value earned, in `currency`."), 86)),
    currency,
    req(p("item_count", "integer", msg("Items in the order."), 3)),
    p("delivery_fee", "number", msg("Delivery fee."), 9),
    p("discount", "number", msg("Discount."), 10),
    p("payment_method", "string", msg("Payment method."), "cash_on_delivery"),
    p("coupon_code", "string", msg("Coupon used."), "FREEDEL"),
  ],
  order_ref: [req(p("order_id", "string", msg("Order id."), "ORD-1001")), p("reason", "string", msg("Reason, if cancelled."), "late_delivery"), p("cancelled_by", "string", msg("Who cancelled."), "customer", { allowedValues: ["customer", "vendor", "courier", "system"] })],
  delivery: [req(p("order_id", "string", msg("Order id."), "ORD-1001")), p("delivery_minutes", "integer", msg("Minutes from order to delivery."), 32)],
  review: [req(p("target_id", "string", msg("What was reviewed (order, product, listing, provider id)."), "ORD-1001")), req(p("rating", "integer", msg("Star rating 1–5."), 5)), p("has_text", "boolean", msg("Whether a written review was included."), true)],
  listing: [req(p("listing_id", "string", msg("Listing id."), "lst_77")), p("category", "string", msg("Listing category."), "cars"), p("price", "number", msg("Asking price."), 85000), p("currency", "currency", msg("ISO 4217 code of price."), "SAR"), p("seller_id", "string", msg("Seller's user id."), "user_456")],
  listing_create: [req(p("listing_id", "string", msg("Listing id."), "lst_77")), req(p("category", "string", msg("Listing category."), "cars")), p("price", "number", msg("Asking price."), 85000), p("currency", "currency", msg("ISO 4217 code of price."), "SAR"), p("photo_count", "integer", msg("Photos attached."), 8)],
  conversation: [req(p("conversation_id", "string", msg("Conversation id."), "conv_5")), p("listing_id", "string", msg("Related listing."), "lst_77"), p("recipient_role", "string", msg("Who receives the message."), "seller")],
  offer: [req(p("offer_id", "string", msg("Offer id."), "off_3")), req(p("listing_id", "string", msg("Listing id."), "lst_77")), req(p("amount", "number", msg("Offer amount."), 80000)), currency],
  marketplace_purchase: [
    req(p("transaction_id", "string", msg("Transaction id."), "txn_9f8e7d")),
    req(p("listing_id", "string", msg("Listing id."), "lst_77")),
    p("seller_id", "string", msg("Seller's user id."), "user_456"),
    req(p("revenue", "number", msg("Your take (commission / fee) in `currency`."), 1700)),
    p("gmv", "number", msg("Gross transaction value."), 85000),
    currency,
    p("payment_method", "string", msg("Payment method."), "bank_transfer"),
  ],
  booking_search: [p("location", "string", msg("Searched location."), "Riyadh"), p("check_in", "datetime", msg("Requested date/time."), "2026-11-02T18:00:00Z"), p("guests", "integer", msg("Party size."), 2)],
  bookable: [req(p("item_id", "string", msg("Service / property / slot id."), "svc_12")), p("item_name", "string", msg("Display name."), "Deep tissue massage"), p("price", "number", msg("Price."), 250), p("currency", "currency", msg("ISO 4217 code of price."), "SAR")],
  booking: [
    req(p("booking_id", "string", msg("Booking id."), "bk_301")),
    req(p("item_id", "string", msg("Booked service / property id."), "svc_12")),
    req(p("booking_date", "datetime", msg("When the booking is for."), "2026-11-02T18:00:00Z")),
    req(p("revenue", "number", msg("Amount earned, in `currency`."), 250)),
    currency,
    p("transaction_id", "string", msg("Payment id, if paid."), "txn_77"),
  ],
  booking_ref: [req(p("booking_id", "string", msg("Booking id."), "bk_301")), p("reason", "string", msg("Reason."), "schedule_conflict"), p("cancelled_by", "string", msg("Who cancelled."), "customer")],
  kyc: [p("verification_level", "string", msg("Level being verified."), "basic"), p("method", "string", msg("Method."), "national_id")],
  kyc_failed: [p("verification_level", "string", msg("Level."), "basic"), req(p("failure_reason", "string", msg("Coarse reason code (never raw documents)."), "document_unreadable"))],
  account: [req(p("account_id", "string", msg("Account / wallet id."), "acc_1")), p("account_type", "string", msg("Account type."), "personal")],
  money_movement: [req(p("transaction_id", "string", msg("Transaction id."), "txn_55")), req(p("amount", "number", msg("Amount in `currency`."), 500)), currency, p("method", "string", msg("Funding / transfer method."), "card"), p("fee", "number", msg("Fee you earned, if any."), 2.5)],
  course: [req(p("course_id", "string", msg("Course id."), "crs_8")), p("course_name", "string", msg("Course name."), "Arabic for beginners"), p("category", "string", msg("Subject."), "languages"), p("level", "string", msg("Level."), "beginner")],
  lesson: [req(p("course_id", "string", msg("Course id."), "crs_8")), req(p("lesson_id", "string", msg("Lesson id."), "les_3")), p("lesson_number", "integer", msg("Lesson position in the course."), 3), p("duration_seconds", "integer", msg("Time spent."), 540)],
  provider: [req(p("provider_id", "string", msg("Doctor / clinic / provider id."), "prv_9")), p("specialty", "string", msg("Specialty (broad category only)."), "dermatology")],
  appointment: [req(p("appointment_id", "string", msg("Appointment id."), "apt_4")), req(p("provider_id", "string", msg("Provider id."), "prv_9")), p("appointment_type", "string", msg("Visit type."), "video", { allowedValues: ["in_person", "video", "chat", "home_visit"] }), p("revenue", "number", msg("Amount earned, if paid."), 200), p("currency", "currency", msg("ISO 4217 code."), "SAR")],
  appointment_ref: [req(p("appointment_id", "string", msg("Appointment id."), "apt_4")), p("reason", "string", msg("Reason."), "rescheduled")],
  level: [req(p("level", "integer", msg("Level number."), 4)), p("level_name", "string", msg("Level name."), "Desert run"), p("score", "number", msg("Score."), 1200), p("duration_seconds", "integer", msg("Time spent."), 95)],
  iap: [req(p("transaction_id", "string", msg("Store transaction id."), "GPA.1234-5678")), req(p("product_id", "string", msg("Store product id."), "coins_500")), req(p("revenue", "number", msg("Amount earned, in `currency`."), 19)), currency, p("store", "string", msg("Store."), "google_play", { allowedValues: ["app_store", "google_play", "huawei", "web"] })],
  ad: [req(p("ad_unit", "string", msg("Ad unit / placement."), "rewarded_level_end")), p("ad_network", "string", msg("Network."), "admob"), p("revenue", "number", msg("Estimated ad revenue, if reported."), 0.002), p("currency", "currency", msg("ISO 4217 code."), "USD")],
  achievement: [req(p("achievement_id", "string", msg("Achievement id."), "first_win"))],
  content: [req(p("content_id", "string", msg("Content id."), "post_1")), p("content_type", "string", msg("Content type."), "video")],
  content_create: [req(p("content_id", "string", msg("Content id."), "post_1")), req(p("content_type", "string", msg("Content type."), "video")), p("has_media", "boolean", msg("Includes photo/video."), true)],
  follow: [req(p("target_user_id", "string", msg("Followed user id."), "user_789"))],
  message: [req(p("conversation_id", "string", msg("Conversation id."), "conv_5")), p("message_type", "string", msg("Text / image / voice."), "text")],
  share: [req(p("content_id", "string", msg("Shared content id."), "post_1")), p("channel", "string", msg("Share target."), "whatsapp")],
  workspace: [req(p("workspace_id", "string", msg("Workspace / team id."), "ws_1"))],
  invite: [p("workspace_id", "string", msg("Workspace id."), "ws_1"), p("invitee_count", "integer", msg("People invited."), 2), p("channel", "string", msg("How the invite was sent."), "email")],
  feature: [req(p("feature_name", "string", msg("Feature used."), "export_report")), p("workspace_id", "string", msg("Workspace id."), "ws_1")],
  lead_form: [req(p("form_name", "string", msg("Which form."), "car_finance_quote"))],
  lead: [req(p("lead_id", "string", msg("Lead id."), "lead_31")), req(p("form_name", "string", msg("Which form."), "car_finance_quote")), p("lead_type", "string", msg("Lead type."), "finance")],
  lead_qualified: [req(p("lead_id", "string", msg("Lead id."), "lead_31")), p("value", "number", msg("Expected value, if known."), 400), p("currency", "currency", msg("ISO 4217 code."), "SAR")],
  referral_share: [p("channel", "string", msg("Share channel."), "whatsapp"), req(p("referral_code", "string", msg("The user's referral code."), "AHMED10"))],
  referral: [req(p("referral_code", "string", msg("Code used."), "AHMED10")), req(p("referrer_user_id", "string", msg("Referrer's user id."), "user_456"))],
  reward: [req(p("reward_id", "string", msg("Reward / rule id."), "rw_1")), req(p("points", "integer", msg("Points earned or spent."), 100)), p("reward_type", "string", msg("Reward type."), "cashback")],
  wishlist: [productId, p("product_name", "string", msg("Product name."), "Air Runner")],
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
