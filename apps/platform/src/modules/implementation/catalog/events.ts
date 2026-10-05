/**
 * Event library: every event the engine can recommend, with its default
 * specification and the reason it exists. Models, features and journey phrases
 * (./models.ts) decide which of these a given app actually gets.
 *
 * Naming convention: object_action in past tense, snake_case.
 */
import type { PropertySetKey } from "./properties";

export type EventSource = "mobile_sdk" | "backend" | "both" | "automatic";
export type Priority = "critical" | "high" | "medium" | "low";
export type EventCategory =
  | "lifecycle" | "account" | "onboarding" | "discovery" | "commerce" | "revenue" | "subscription"
  | "fulfilment" | "marketplace" | "booking" | "fintech" | "learning" | "health" | "gaming"
  | "social" | "engagement" | "growth" | "messaging" | "lead";

export interface EventDefinition {
  name: string;
  display: string;
  description: string;
  category: EventCategory;
  trigger: string;
  source: EventSource;
  priority: Priority;
  properties: PropertySetKey | null;
  conversion?: boolean;
  revenue?: boolean;
  attribution?: boolean;
  automation?: boolean;
  /** Default rationale; the generator prepends context-specific reasons. */
  reason: string;
  /** Explanation shown when the source is backend. */
  sourceNote?: string;
}

const BACKEND_PAYMENT =
  "Send this from your backend after the payment provider confirms. Payment confirmation must not depend on the mobile client, which can crash, go offline or be tampered with.";

const defs: EventDefinition[] = [
  // ── Lifecycle (captured automatically by the SDK) ─────────────────────────
  { name: "app_installed", display: "App Installed", description: "First launch after install.", category: "lifecycle", trigger: "First app open after install (SDK, automatic).", source: "automatic", priority: "critical", properties: null, attribution: true, automation: true, reason: "Anchors install attribution and every acquisition report." },
  { name: "app_opened", display: "App Opened", description: "App launched or brought to foreground.", category: "lifecycle", trigger: "App comes to foreground (SDK, automatic).", source: "automatic", priority: "high", properties: "app_opened", attribution: true, reason: "Drives sessions, active users and re-engagement attribution." },
  { name: "app_updated", display: "App Updated", description: "First launch on a new app version.", category: "lifecycle", trigger: "First launch after version change (SDK, automatic).", source: "automatic", priority: "low", properties: "app_updated", reason: "Lets you compare behaviour across app versions." },
  { name: "screen_viewed", display: "Screen Viewed", description: "A screen became visible.", category: "lifecycle", trigger: "Analytics.screen(name) on each screen.", source: "mobile_sdk", priority: "medium", properties: "screen", reason: "Screens per session and navigation paths for UX analysis." },
  { name: "deep_link_opened", display: "Deep Link Opened", description: "The app was opened from a deep link or universal/app link.", category: "lifecycle", trigger: "App opened via a link (SDK, automatic when link handling is wired).", source: "automatic", priority: "high", properties: "deep_link", attribution: true, reason: "Preserves campaign data from links and powers re-engagement attribution." },
  { name: "push_opened", display: "Push Opened", description: "User tapped a push notification.", category: "messaging", trigger: "Notification tap (SDK, automatic).", source: "automatic", priority: "medium", properties: "push_opened", automation: true, reason: "Measures push and automation effectiveness." },

  // ── Account & onboarding ──────────────────────────────────────────────────
  { name: "signup_started", display: "Signup Started", description: "User began account creation.", category: "account", trigger: "User opens the signup form or enters a phone number.", source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: "Finds where registration drops off." },
  { name: "signup_completed", display: "Signup Completed", description: "Account created successfully.", category: "account", trigger: "Your server confirmed the account; call identify(user_id) then track.", source: "mobile_sdk", priority: "critical", properties: "signup", conversion: true, attribution: true, automation: true, reason: "The first conversion after install and the moment anonymous activity joins a known user." },
  { name: "login_completed", display: "Login Completed", description: "User signed in.", category: "account", trigger: "Successful sign-in; call identify(user_id).", source: "mobile_sdk", priority: "medium", properties: "login", reason: "Links devices to the same user across reinstalls." },
  { name: "onboarding_started", display: "Onboarding Started", description: "First onboarding step shown.", category: "onboarding", trigger: "First onboarding screen.", source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: "Baseline for onboarding completion rate." },
  { name: "onboarding_completed", display: "Onboarding Completed", description: "User finished onboarding.", category: "onboarding", trigger: "Last onboarding step submitted.", source: "mobile_sdk", priority: "high", properties: "onboarding_step", automation: true, reason: "Users who skip onboarding are a classic automation target." },

  // ── Discovery & commerce ──────────────────────────────────────────────────
  { name: "search_performed", display: "Search Performed", description: "User ran a search.", category: "discovery", trigger: "Search submitted and results returned.", source: "mobile_sdk", priority: "medium", properties: "search", reason: "Shows demand, zero-result searches and search-to-purchase conversion." },
  { name: "product_list_viewed", display: "Product List Viewed", description: "Category or list page viewed.", category: "discovery", trigger: "A product list or category screen is shown.", source: "mobile_sdk", priority: "low", properties: "product_list", reason: "Top of the browsing funnel." },
  { name: "product_viewed", display: "Product Viewed", description: "Product detail viewed.", category: "commerce", trigger: "Product detail screen shown.", source: "mobile_sdk", priority: "high", properties: "product", automation: true, reason: "Browse abandonment and product interest; first step of the purchase funnel." },
  { name: "product_added_to_cart", display: "Product Added to Cart", description: "Item added to cart.", category: "commerce", trigger: "Add-to-cart succeeded.", source: "mobile_sdk", priority: "high", properties: "cart_item", automation: true, reason: "Cart abandonment automation and funnel step." },
  { name: "product_removed_from_cart", display: "Product Removed from Cart", description: "Item removed from cart.", category: "commerce", trigger: "Item removed or quantity reduced to zero.", source: "mobile_sdk", priority: "low", properties: "cart_item", reason: "Reveals price or delivery-fee friction." },
  { name: "cart_viewed", display: "Cart Viewed", description: "Cart screen opened.", category: "commerce", trigger: "Cart screen shown.", source: "mobile_sdk", priority: "medium", properties: "cart", reason: "Funnel step between adding and checking out." },
  { name: "wishlist_added", display: "Wishlist Added", description: "Item saved to wishlist / favourites.", category: "commerce", trigger: "Item favourited.", source: "mobile_sdk", priority: "low", properties: "wishlist", automation: true, reason: "Price-drop and back-in-stock automation." },
  { name: "checkout_started", display: "Checkout Started", description: "User began checkout.", category: "commerce", trigger: "Checkout screen opened with a non-empty cart.", source: "mobile_sdk", priority: "high", properties: "checkout", conversion: true, automation: true, reason: "Checkout abandonment is usually the highest-value automation." },
  { name: "purchase_completed", display: "Purchase Completed", description: "Payment succeeded for an order.", category: "revenue", trigger: "Successful server-side payment confirmation.", source: "backend", priority: "critical", properties: "purchase", conversion: true, revenue: true, attribution: true, automation: true, reason: "Your revenue event: ROAS, LTV and purchase funnels all depend on it.", sourceNote: BACKEND_PAYMENT },
  { name: "refund_completed", display: "Refund Completed", description: "A payment was refunded.", category: "revenue", trigger: "Refund processed by your backend.", source: "backend", priority: "medium", properties: "refund", revenue: true, reason: "Net revenue is wrong without refunds.", sourceNote: "Refunds happen in your backend or payment provider, never on the device." },

  // ── Subscription ──────────────────────────────────────────────────────────
  { name: "paywall_viewed", display: "Paywall Viewed", description: "Paywall or plan picker shown.", category: "subscription", trigger: "Paywall rendered.", source: "mobile_sdk", priority: "medium", properties: "paywall", automation: true, reason: "Paywall conversion rate is the core subscription funnel metric." },
  { name: "trial_started", display: "Trial Started", description: "Free trial began.", category: "subscription", trigger: "Store / billing confirms the trial.", source: "backend", priority: "high", properties: "trial", conversion: true, attribution: true, automation: true, reason: "Trial-to-paid is the key subscription conversion.", sourceNote: "Confirm trials from store server notifications or your billing system." },
  { name: "subscription_started", display: "Subscription Started", description: "First paid subscription period.", category: "revenue", trigger: "Billing confirms the first paid charge.", source: "backend", priority: "critical", properties: "subscription", conversion: true, revenue: true, attribution: true, automation: true, reason: "Your subscription revenue and conversion event.", sourceNote: "Use App Store Server Notifications / Google Play RTDN or your billing webhooks. Client-side receipts are not reliable revenue." },
  { name: "subscription_renewed", display: "Subscription Renewed", description: "A recurring charge succeeded.", category: "revenue", trigger: "Renewal charge confirmed.", source: "backend", priority: "high", properties: "subscription", revenue: true, reason: "Recurring revenue and retention.", sourceNote: "Renewals happen while the app is closed; only your backend sees them." },
  { name: "subscription_cancelled", display: "Subscription Cancelled", description: "Auto-renew turned off.", category: "subscription", trigger: "Cancellation confirmed by billing.", source: "backend", priority: "high", properties: "subscription_ref", automation: true, reason: "Win-back automation and churn analysis.", sourceNote: "Cancellations often happen in store settings, outside your app." },
  { name: "subscription_expired", display: "Subscription Expired", description: "Access ended.", category: "subscription", trigger: "Billing reports expiry.", source: "backend", priority: "medium", properties: "subscription_ref", automation: true, reason: "Defines churned subscribers.", sourceNote: "Only your billing system knows when access ends." },

  // ── Delivery ──────────────────────────────────────────────────────────────
  { name: "vendor_viewed", display: "Store Viewed", description: "Store / restaurant page viewed.", category: "discovery", trigger: "Store or restaurant page shown.", source: "mobile_sdk", priority: "high", properties: "vendor", automation: true, reason: "Measures which stores attract and convert demand." },
  { name: "menu_viewed", display: "Menu Viewed", description: "Menu or catalogue section viewed.", category: "discovery", trigger: "Menu section shown.", source: "mobile_sdk", priority: "low", properties: "menu", reason: "Menu depth before ordering." },
  { name: "order_completed", display: "Order Completed", description: "Order placed and paid (or confirmed for cash on delivery).", category: "revenue", trigger: "Your backend confirms the order (payment captured or COD accepted).", source: "backend", priority: "critical", properties: "order", conversion: true, revenue: true, attribution: true, automation: true, reason: "Your revenue and conversion event.", sourceNote: BACKEND_PAYMENT },
  { name: "order_delivered", display: "Order Delivered", description: "Order reached the customer.", category: "fulfilment", trigger: "Courier marks the order delivered.", source: "backend", priority: "medium", properties: "delivery", automation: true, reason: "Triggers review requests and reorder nudges; delivery time drives retention.", sourceNote: "Delivery status lives in your logistics system." },
  { name: "order_cancelled", display: "Order Cancelled", description: "Order cancelled.", category: "fulfilment", trigger: "Cancellation confirmed by your backend.", source: "backend", priority: "high", properties: "order_ref", revenue: true, automation: true, reason: "Cancellations reduce net revenue and predict churn.", sourceNote: "Vendors, couriers and systems cancel orders, not only the app user." },
  { name: "review_submitted", display: "Review Submitted", description: "User submitted a rating or review.", category: "engagement", trigger: "Review saved.", source: "mobile_sdk", priority: "low", properties: "review", reason: "Satisfaction signal that predicts repeat behaviour." },

  // ── Marketplace ───────────────────────────────────────────────────────────
  { name: "listing_viewed", display: "Listing Viewed", description: "Listing detail viewed.", category: "marketplace", trigger: "Listing detail screen shown.", source: "mobile_sdk", priority: "high", properties: "listing", automation: true, reason: "Demand side of the marketplace funnel." },
  { name: "listing_created", display: "Listing Created", description: "Seller started a listing.", category: "marketplace", trigger: "Listing draft saved.", source: "mobile_sdk", priority: "high", properties: "listing_create", automation: true, reason: "Supply side activation; drafts that never publish are an automation target." },
  { name: "listing_published", display: "Listing Published", description: "Listing went live.", category: "marketplace", trigger: "Listing approved / published by your backend.", source: "backend", priority: "high", properties: "listing_create", conversion: true, reason: "Supply-side conversion.", sourceNote: "Publishing usually passes moderation on your server." },
  { name: "message_started", display: "Message Started", description: "Buyer contacted a seller.", category: "marketplace", trigger: "First message in a conversation sent.", source: "mobile_sdk", priority: "high", properties: "conversation", conversion: true, automation: true, reason: "Contact is the key intent signal in classifieds-style marketplaces." },
  { name: "offer_created", display: "Offer Created", description: "Buyer made an offer.", category: "marketplace", trigger: "Offer submitted.", source: "mobile_sdk", priority: "medium", properties: "offer", automation: true, reason: "Negotiation step before a transaction." },

  // ── Booking ───────────────────────────────────────────────────────────────
  { name: "availability_searched", display: "Availability Searched", description: "User searched dates / slots.", category: "booking", trigger: "Availability search submitted.", source: "mobile_sdk", priority: "medium", properties: "booking_search", reason: "Top of the booking funnel and demand by date." },
  { name: "bookable_viewed", display: "Bookable Item Viewed", description: "Service / property / slot detail viewed.", category: "booking", trigger: "Detail screen shown.", source: "mobile_sdk", priority: "high", properties: "bookable", automation: true, reason: "Interest signal for browse-abandonment automation." },
  { name: "booking_started", display: "Booking Started", description: "User began booking.", category: "booking", trigger: "Booking form opened.", source: "mobile_sdk", priority: "high", properties: "bookable", conversion: true, automation: true, reason: "Booking abandonment automation." },
  { name: "booking_completed", display: "Booking Completed", description: "Booking confirmed.", category: "revenue", trigger: "Your backend confirms the booking (and payment, if prepaid).", source: "backend", priority: "critical", properties: "booking", conversion: true, revenue: true, attribution: true, automation: true, reason: "Your conversion and revenue event.", sourceNote: BACKEND_PAYMENT },
  { name: "booking_cancelled", display: "Booking Cancelled", description: "Booking cancelled.", category: "booking", trigger: "Cancellation confirmed.", source: "backend", priority: "medium", properties: "booking_ref", revenue: true, automation: true, reason: "Net bookings and cancellation reasons.", sourceNote: "Providers and systems cancel too, not only the user." },

  // ── Fintech ───────────────────────────────────────────────────────────────
  { name: "kyc_started", display: "KYC Started", description: "Identity verification began.", category: "fintech", trigger: "First KYC step shown.", source: "mobile_sdk", priority: "high", properties: "kyc", automation: true, reason: "KYC drop-off is the biggest leak in most fintech funnels." },
  { name: "kyc_completed", display: "KYC Completed", description: "Identity verified.", category: "fintech", trigger: "Verification provider approves.", source: "backend", priority: "critical", properties: "kyc", conversion: true, attribution: true, automation: true, reason: "Verified users are the real acquisition outcome in fintech.", sourceNote: "Verification results come from your KYC provider, not the device." },
  { name: "kyc_failed", display: "KYC Failed", description: "Verification rejected.", category: "fintech", trigger: "Verification provider rejects.", source: "backend", priority: "medium", properties: "kyc_failed", automation: true, reason: "Targeted help for users who failed verification.", sourceNote: "Send only a coarse reason code; never documents or raw identity data." },
  { name: "account_created", display: "Account Created", description: "Wallet / account opened.", category: "fintech", trigger: "Core banking / ledger creates the account.", source: "backend", priority: "high", properties: "account", conversion: true, reason: "Account opening rate.", sourceNote: "Accounts are created in your ledger." },
  { name: "deposit_completed", display: "Deposit Completed", description: "Funds added.", category: "fintech", trigger: "Ledger confirms the deposit.", source: "backend", priority: "critical", properties: "money_movement", conversion: true, attribution: true, automation: true, reason: "First funded account is the usual fintech activation.", sourceNote: "Money movement is confirmed only by your ledger." },
  { name: "transfer_completed", display: "Transfer Completed", description: "Transfer / payment sent.", category: "fintech", trigger: "Ledger confirms the transfer.", source: "backend", priority: "high", properties: "money_movement", conversion: true, revenue: true, automation: true, reason: "Core usage and fee revenue.", sourceNote: "Money movement is confirmed only by your ledger." },

  // ── EdTech ────────────────────────────────────────────────────────────────
  { name: "course_viewed", display: "Course Viewed", description: "Course page viewed.", category: "learning", trigger: "Course detail shown.", source: "mobile_sdk", priority: "medium", properties: "course", automation: true, reason: "Interest by subject; browse abandonment." },
  { name: "course_started", display: "Course Started", description: "User enrolled / started a course.", category: "learning", trigger: "Enrolment confirmed.", source: "mobile_sdk", priority: "high", properties: "course", conversion: true, automation: true, reason: "Enrolment conversion." },
  { name: "lesson_started", display: "Lesson Started", description: "Lesson opened.", category: "learning", trigger: "Lesson player opened.", source: "mobile_sdk", priority: "medium", properties: "lesson", reason: "Lesson completion rate." },
  { name: "lesson_completed", display: "Lesson Completed", description: "Lesson finished.", category: "learning", trigger: "Lesson marked complete.", source: "mobile_sdk", priority: "critical", properties: "lesson", automation: true, reason: "Learning progress is the value users come for." },
  { name: "course_completed", display: "Course Completed", description: "Course finished.", category: "learning", trigger: "All lessons complete (your backend decides).", source: "backend", priority: "high", properties: "course", automation: true, reason: "Completion drives renewals and referrals.", sourceNote: "Course completion is computed from progress stored on your server." },

  // ── Healthcare ────────────────────────────────────────────────────────────
  { name: "provider_viewed", display: "Provider Viewed", description: "Doctor / clinic profile viewed.", category: "health", trigger: "Provider profile shown.", source: "mobile_sdk", priority: "medium", properties: "provider", reason: "Demand by specialty (broad categories only)." },
  { name: "appointment_booking_started", display: "Appointment Booking Started", description: "User began booking.", category: "health", trigger: "Booking form opened.", source: "mobile_sdk", priority: "high", properties: "provider", automation: true, reason: "Booking abandonment follow-up." },
  { name: "appointment_booked", display: "Appointment Booked", description: "Appointment confirmed.", category: "revenue", trigger: "Your backend confirms the appointment.", source: "backend", priority: "critical", properties: "appointment", conversion: true, revenue: true, attribution: true, automation: true, reason: "Your conversion event.", sourceNote: "Confirmation and payment happen on your server." },
  { name: "appointment_cancelled", display: "Appointment Cancelled", description: "Appointment cancelled.", category: "health", trigger: "Cancellation confirmed.", source: "backend", priority: "medium", properties: "appointment_ref", automation: true, reason: "Cancellation and no-show analysis.", sourceNote: "Providers cancel too." },
  { name: "consultation_completed", display: "Consultation Completed", description: "Visit or consultation took place.", category: "health", trigger: "Provider closes the consultation.", source: "backend", priority: "high", properties: "appointment_ref", automation: true, reason: "Delivered care is the value; drives follow-up reminders.", sourceNote: "Only the provider system knows the visit happened." },

  // ── Gaming ────────────────────────────────────────────────────────────────
  { name: "tutorial_completed", display: "Tutorial Completed", description: "Tutorial finished.", category: "gaming", trigger: "Last tutorial step.", source: "mobile_sdk", priority: "high", properties: null, automation: true, reason: "Day-1 retention depends on tutorial completion." },
  { name: "level_started", display: "Level Started", description: "Level began.", category: "gaming", trigger: "Level loads.", source: "mobile_sdk", priority: "medium", properties: "level", reason: "Difficulty and drop-off by level." },
  { name: "level_completed", display: "Level Completed", description: "Level won.", category: "gaming", trigger: "Level success screen.", source: "mobile_sdk", priority: "high", properties: "level", automation: true, reason: "Core progression." },
  { name: "level_failed", display: "Level Failed", description: "Level lost.", category: "gaming", trigger: "Level fail screen.", source: "mobile_sdk", priority: "medium", properties: "level", reason: "Finds frustrating levels." },
  { name: "in_app_purchase_completed", display: "In-App Purchase Completed", description: "Store purchase verified.", category: "revenue", trigger: "Your server validates the store receipt.", source: "backend", priority: "critical", properties: "iap", conversion: true, revenue: true, attribution: true, automation: true, reason: "IAP revenue for ROAS and LTV.", sourceNote: "Validate receipts server-side; client-reported purchases are easy to fake." },
  { name: "ad_impression", display: "Ad Impression", description: "An ad was shown.", category: "revenue", trigger: "Ad network impression callback.", source: "mobile_sdk", priority: "medium", properties: "ad", revenue: true, reason: "Ad-funded revenue per user." },
  { name: "achievement_unlocked", display: "Achievement Unlocked", description: "Achievement earned.", category: "gaming", trigger: "Achievement granted.", source: "mobile_sdk", priority: "low", properties: "achievement", reason: "Engagement depth." },

  // ── Social / content ──────────────────────────────────────────────────────
  { name: "profile_completed", display: "Profile Completed", description: "Profile filled in.", category: "onboarding", trigger: "Profile saved with required fields.", source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: "Complete profiles retain better." },
  { name: "content_viewed", display: "Content Viewed", description: "Post / video / article viewed.", category: "engagement", trigger: "Content shown for more than ~2 seconds.", source: "mobile_sdk", priority: "medium", properties: "content", reason: "Consumption side of engagement." },
  { name: "content_created", display: "Content Created", description: "User published content.", category: "engagement", trigger: "Post published.", source: "mobile_sdk", priority: "high", properties: "content_create", automation: true, reason: "Creators drive network value." },
  { name: "content_liked", display: "Content Liked", description: "Like / reaction.", category: "engagement", trigger: "Reaction saved.", source: "mobile_sdk", priority: "low", properties: "content", reason: "Lightweight engagement signal." },
  { name: "comment_posted", display: "Comment Posted", description: "Comment added.", category: "engagement", trigger: "Comment saved.", source: "mobile_sdk", priority: "medium", properties: "content", reason: "Meaningful interaction." },
  { name: "user_followed", display: "User Followed", description: "User followed another user.", category: "social", trigger: "Follow saved.", source: "mobile_sdk", priority: "medium", properties: "follow", automation: true, reason: "Graph density predicts retention." },
  { name: "message_sent", display: "Message Sent", description: "Direct message sent.", category: "social", trigger: "Message delivered to server.", source: "mobile_sdk", priority: "medium", properties: "message", reason: "Conversation activity." },
  { name: "content_shared", display: "Content Shared", description: "Content shared outside the app.", category: "growth", trigger: "Share sheet completed.", source: "mobile_sdk", priority: "medium", properties: "share", attribution: true, reason: "Viral loop measurement." },

  // ── SaaS ──────────────────────────────────────────────────────────────────
  { name: "workspace_created", display: "Workspace Created", description: "Team / workspace created.", category: "onboarding", trigger: "Workspace saved.", source: "backend", priority: "high", properties: "workspace", conversion: true, automation: true, reason: "Account-level activation for B2B.", sourceNote: "Workspaces are created server-side." },
  { name: "teammate_invited", display: "Teammate Invited", description: "Invitation sent.", category: "growth", trigger: "Invite sent.", source: "mobile_sdk", priority: "high", properties: "invite", automation: true, reason: "Multi-user accounts retain far better." },
  { name: "feature_used", display: "Feature Used", description: "Core feature used.", category: "engagement", trigger: "Key feature action completed.", source: "mobile_sdk", priority: "high", properties: "feature", reason: "Feature adoption and depth of use." },

  // ── Lead generation ───────────────────────────────────────────────────────
  { name: "lead_form_started", display: "Lead Form Started", description: "Lead form opened.", category: "lead", trigger: "Form opened.", source: "mobile_sdk", priority: "medium", properties: "lead_form", automation: true, reason: "Form abandonment follow-up." },
  { name: "lead_submitted", display: "Lead Submitted", description: "Lead form submitted.", category: "lead", trigger: "Your server accepts the lead.", source: "backend", priority: "critical", properties: "lead", conversion: true, attribution: true, automation: true, reason: "Your conversion event.", sourceNote: "Count leads your server accepted, not form taps that may fail." },
  { name: "lead_qualified", display: "Lead Qualified", description: "Sales qualified the lead.", category: "lead", trigger: "CRM status changes to qualified.", source: "backend", priority: "high", properties: "lead_qualified", conversion: true, revenue: true, attribution: true, reason: "Optimise campaigns on lead quality, not volume.", sourceNote: "Qualification happens in your CRM." },

  // ── Growth loops ──────────────────────────────────────────────────────────
  { name: "referral_link_shared", display: "Referral Link Shared", description: "User shared a referral link.", category: "growth", trigger: "Share completed.", source: "mobile_sdk", priority: "medium", properties: "referral_share", attribution: true, reason: "Top of the referral loop." },
  { name: "referral_completed", display: "Referral Completed", description: "A referred user qualified.", category: "growth", trigger: "Your backend credits the referral.", source: "backend", priority: "high", properties: "referral", conversion: true, attribution: true, automation: true, reason: "Referral programme ROI.", sourceNote: "Referral qualification and rewards are decided by your server." },
  { name: "reward_earned", display: "Reward Earned", description: "Points / cashback earned.", category: "growth", trigger: "Ledger credits the reward.", source: "backend", priority: "medium", properties: "reward", automation: true, reason: "Loyalty engagement.", sourceNote: "Rewards balances live on your server." },
  { name: "reward_redeemed", display: "Reward Redeemed", description: "Reward redeemed.", category: "growth", trigger: "Redemption confirmed.", source: "backend", priority: "medium", properties: "reward", automation: true, reason: "Loyalty value delivered.", sourceNote: "Redemptions are confirmed by your server." },
];

export const EVENT_LIBRARY: Record<string, EventDefinition> = Object.fromEntries(defs.map((d) => [d.name, d]));

export function getEventDefinition(name: string): EventDefinition {
  const d = EVENT_LIBRARY[name];
  if (!d) throw new Error(`Unknown event in library: ${name}`);
  return d;
}
