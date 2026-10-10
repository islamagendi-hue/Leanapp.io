/**
 * Event library: every event the engine can recommend, with its default
 * specification and the reason it exists. Models, features and journey phrases
 * (./models.ts) decide which of these a given app actually gets.
 *
 * Naming convention: object_action in past tense, snake_case.
 */
import { msg } from "@/i18n/translate";
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

const BACKEND_PAYMENT = msg(
  "Send this from your backend after the payment provider confirms. Payment confirmation must not depend on the mobile client, which can crash, go offline or be tampered with.",
);

const defs: EventDefinition[] = [
  // ── Lifecycle (captured automatically by the SDK) ─────────────────────────
  { name: "app_installed", display: "App Installed", description: msg("First launch after install."), category: "lifecycle", trigger: msg("First app open after install (SDK, automatic)."), source: "automatic", priority: "critical", properties: null, attribution: true, automation: true, reason: msg("Anchors install attribution and every acquisition report.") },
  { name: "app_opened", display: "App Opened", description: msg("App launched or brought to foreground."), category: "lifecycle", trigger: msg("App comes to foreground (SDK, automatic)."), source: "automatic", priority: "high", properties: "app_opened", attribution: true, reason: msg("Drives sessions, active users and re-engagement attribution.") },
  { name: "app_updated", display: "App Updated", description: msg("First launch on a new app version."), category: "lifecycle", trigger: msg("First launch after version change (SDK, automatic)."), source: "automatic", priority: "low", properties: "app_updated", reason: msg("Lets you compare behaviour across app versions.") },
  { name: "screen_viewed", display: "Screen Viewed", description: msg("A screen became visible."), category: "lifecycle", trigger: msg("Analytics.screen(name) on each screen."), source: "mobile_sdk", priority: "medium", properties: "screen", reason: msg("Screens per session and navigation paths for UX analysis.") },
  { name: "deep_link_opened", display: "Deep Link Opened", description: msg("The app was opened from a deep link or universal/app link."), category: "lifecycle", trigger: msg("App opened via a link (SDK, automatic when link handling is wired)."), source: "automatic", priority: "high", properties: "deep_link", attribution: true, reason: msg("Preserves campaign data from links and powers re-engagement attribution.") },
  { name: "push_opened", display: "Push Opened", description: msg("User tapped a push notification."), category: "messaging", trigger: msg("Notification tap (SDK, automatic)."), source: "automatic", priority: "medium", properties: "push_opened", automation: true, reason: msg("Measures push and automation effectiveness.") },

  // ── Account & onboarding ──────────────────────────────────────────────────
  { name: "signup_started", display: "Signup Started", description: msg("User began account creation."), category: "account", trigger: msg("User opens the signup form or enters a phone number."), source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: msg("Finds where registration drops off.") },
  { name: "signup_completed", display: "Signup Completed", description: msg("Account created successfully."), category: "account", trigger: msg("Your server confirmed the account; call identify(user_id) then track."), source: "mobile_sdk", priority: "critical", properties: "signup", conversion: true, attribution: true, automation: true, reason: msg("The first conversion after install and the moment anonymous activity joins a known user.") },
  { name: "login_completed", display: "Login Completed", description: msg("User signed in."), category: "account", trigger: msg("Successful sign-in; call identify(user_id)."), source: "mobile_sdk", priority: "medium", properties: "login", reason: msg("Links devices to the same user across reinstalls.") },
  { name: "onboarding_started", display: "Onboarding Started", description: msg("First onboarding step shown."), category: "onboarding", trigger: msg("First onboarding screen."), source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: msg("Baseline for onboarding completion rate.") },
  { name: "onboarding_completed", display: "Onboarding Completed", description: msg("User finished onboarding."), category: "onboarding", trigger: msg("Last onboarding step submitted."), source: "mobile_sdk", priority: "high", properties: "onboarding_step", automation: true, reason: msg("Users who skip onboarding are a classic automation target.") },

  // ── Discovery & commerce ──────────────────────────────────────────────────
  { name: "search_performed", display: "Search Performed", description: msg("User ran a search."), category: "discovery", trigger: msg("Search submitted and results returned."), source: "mobile_sdk", priority: "medium", properties: "search", reason: msg("Shows demand, zero-result searches and search-to-purchase conversion.") },
  { name: "product_list_viewed", display: "Product List Viewed", description: msg("Category or list page viewed."), category: "discovery", trigger: msg("A product list or category screen is shown."), source: "mobile_sdk", priority: "low", properties: "product_list", reason: msg("Top of the browsing funnel.") },
  { name: "product_viewed", display: "Product Viewed", description: msg("Product detail viewed."), category: "commerce", trigger: msg("Product detail screen shown."), source: "mobile_sdk", priority: "high", properties: "product", automation: true, reason: msg("Browse abandonment and product interest; first step of the purchase funnel.") },
  { name: "product_added_to_cart", display: "Product Added to Cart", description: msg("Item added to cart."), category: "commerce", trigger: msg("Add-to-cart succeeded."), source: "mobile_sdk", priority: "high", properties: "cart_item", automation: true, reason: msg("Cart abandonment automation and funnel step.") },
  { name: "product_removed_from_cart", display: "Product Removed from Cart", description: msg("Item removed from cart."), category: "commerce", trigger: msg("Item removed or quantity reduced to zero."), source: "mobile_sdk", priority: "low", properties: "cart_item", reason: msg("Reveals price or delivery-fee friction.") },
  { name: "cart_viewed", display: "Cart Viewed", description: msg("Cart screen opened."), category: "commerce", trigger: msg("Cart screen shown."), source: "mobile_sdk", priority: "medium", properties: "cart", reason: msg("Funnel step between adding and checking out.") },
  { name: "wishlist_added", display: "Wishlist Added", description: msg("Item saved to wishlist / favourites."), category: "commerce", trigger: msg("Item favourited."), source: "mobile_sdk", priority: "low", properties: "wishlist", automation: true, reason: msg("Price-drop and back-in-stock automation.") },
  { name: "checkout_started", display: "Checkout Started", description: msg("User began checkout."), category: "commerce", trigger: msg("Checkout screen opened with a non-empty cart."), source: "mobile_sdk", priority: "high", properties: "checkout", conversion: true, automation: true, reason: msg("Checkout abandonment is usually the highest-value automation.") },
  { name: "purchase_completed", display: "Purchase Completed", description: msg("Payment succeeded for an order."), category: "revenue", trigger: msg("Successful server-side payment confirmation."), source: "backend", priority: "critical", properties: "purchase", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("Your revenue event: ROAS, LTV and purchase funnels all depend on it."), sourceNote: BACKEND_PAYMENT },
  { name: "refund_completed", display: "Refund Completed", description: msg("A payment was refunded."), category: "revenue", trigger: msg("Refund processed by your backend."), source: "backend", priority: "medium", properties: "refund", revenue: true, reason: msg("Net revenue is wrong without refunds."), sourceNote: msg("Refunds happen in your backend or payment provider, never on the device.") },

  // ── Subscription ──────────────────────────────────────────────────────────
  { name: "paywall_viewed", display: "Paywall Viewed", description: msg("Paywall or plan picker shown."), category: "subscription", trigger: msg("Paywall rendered."), source: "mobile_sdk", priority: "medium", properties: "paywall", automation: true, reason: msg("Paywall conversion rate is the core subscription funnel metric.") },
  { name: "trial_started", display: "Trial Started", description: msg("Free trial began."), category: "subscription", trigger: msg("Store / billing confirms the trial."), source: "backend", priority: "high", properties: "trial", conversion: true, attribution: true, automation: true, reason: msg("Trial-to-paid is the key subscription conversion."), sourceNote: msg("Confirm trials from store server notifications or your billing system.") },
  { name: "subscription_started", display: "Subscription Started", description: msg("First paid subscription period."), category: "revenue", trigger: msg("Billing confirms the first paid charge."), source: "backend", priority: "critical", properties: "subscription", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("Your subscription revenue and conversion event."), sourceNote: msg("Use App Store Server Notifications / Google Play RTDN or your billing webhooks. Client-side receipts are not reliable revenue.") },
  { name: "subscription_renewed", display: "Subscription Renewed", description: msg("A recurring charge succeeded."), category: "revenue", trigger: msg("Renewal charge confirmed."), source: "backend", priority: "high", properties: "subscription", revenue: true, reason: msg("Recurring revenue and retention."), sourceNote: msg("Renewals happen while the app is closed; only your backend sees them.") },
  { name: "subscription_cancelled", display: "Subscription Cancelled", description: msg("Auto-renew turned off."), category: "subscription", trigger: msg("Cancellation confirmed by billing."), source: "backend", priority: "high", properties: "subscription_ref", automation: true, reason: msg("Win-back automation and churn analysis."), sourceNote: msg("Cancellations often happen in store settings, outside your app.") },
  { name: "subscription_expired", display: "Subscription Expired", description: msg("Access ended."), category: "subscription", trigger: msg("Billing reports expiry."), source: "backend", priority: "medium", properties: "subscription_ref", automation: true, reason: msg("Defines churned subscribers."), sourceNote: msg("Only your billing system knows when access ends.") },

  // ── Delivery ──────────────────────────────────────────────────────────────
  { name: "vendor_viewed", display: "Store Viewed", description: msg("Store / restaurant page viewed."), category: "discovery", trigger: msg("Store or restaurant page shown."), source: "mobile_sdk", priority: "high", properties: "vendor", automation: true, reason: msg("Measures which stores attract and convert demand.") },
  { name: "menu_viewed", display: "Menu Viewed", description: msg("Menu or catalogue section viewed."), category: "discovery", trigger: msg("Menu section shown."), source: "mobile_sdk", priority: "low", properties: "menu", reason: msg("Menu depth before ordering.") },
  { name: "order_completed", display: "Order Completed", description: msg("Order placed and paid (or confirmed for cash on delivery)."), category: "revenue", trigger: msg("Your backend confirms the order (payment captured or COD accepted)."), source: "backend", priority: "critical", properties: "order", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("Your revenue and conversion event."), sourceNote: BACKEND_PAYMENT },
  { name: "order_delivered", display: "Order Delivered", description: msg("Order reached the customer."), category: "fulfilment", trigger: msg("Courier marks the order delivered."), source: "backend", priority: "medium", properties: "delivery", automation: true, reason: msg("Triggers review requests and reorder nudges; delivery time drives retention."), sourceNote: msg("Delivery status lives in your logistics system.") },
  { name: "order_cancelled", display: "Order Cancelled", description: msg("Order cancelled."), category: "fulfilment", trigger: msg("Cancellation confirmed by your backend."), source: "backend", priority: "high", properties: "order_ref", revenue: true, automation: true, reason: msg("Cancellations reduce net revenue and predict churn."), sourceNote: msg("Vendors, couriers and systems cancel orders, not only the app user.") },
  { name: "review_submitted", display: "Review Submitted", description: msg("User submitted a rating or review."), category: "engagement", trigger: msg("Review saved."), source: "mobile_sdk", priority: "low", properties: "review", reason: msg("Satisfaction signal that predicts repeat behaviour.") },

  // ── Marketplace ───────────────────────────────────────────────────────────
  { name: "listing_viewed", display: "Listing Viewed", description: msg("Listing detail viewed."), category: "marketplace", trigger: msg("Listing detail screen shown."), source: "mobile_sdk", priority: "high", properties: "listing", automation: true, reason: msg("Demand side of the marketplace funnel.") },
  { name: "listing_created", display: "Listing Created", description: msg("Seller started a listing."), category: "marketplace", trigger: msg("Listing draft saved."), source: "mobile_sdk", priority: "high", properties: "listing_create", automation: true, reason: msg("Supply side activation; drafts that never publish are an automation target.") },
  { name: "listing_published", display: "Listing Published", description: msg("Listing went live."), category: "marketplace", trigger: msg("Listing approved / published by your backend."), source: "backend", priority: "high", properties: "listing_create", conversion: true, reason: msg("Supply-side conversion."), sourceNote: msg("Publishing usually passes moderation on your server.") },
  { name: "message_started", display: "Message Started", description: msg("Buyer contacted a seller."), category: "marketplace", trigger: msg("First message in a conversation sent."), source: "mobile_sdk", priority: "high", properties: "conversation", conversion: true, automation: true, reason: msg("Contact is the key intent signal in classifieds-style marketplaces.") },
  { name: "offer_created", display: "Offer Created", description: msg("Buyer made an offer."), category: "marketplace", trigger: msg("Offer submitted."), source: "mobile_sdk", priority: "medium", properties: "offer", automation: true, reason: msg("Negotiation step before a transaction.") },

  // ── Booking ───────────────────────────────────────────────────────────────
  { name: "availability_searched", display: "Availability Searched", description: msg("User searched dates / slots."), category: "booking", trigger: msg("Availability search submitted."), source: "mobile_sdk", priority: "medium", properties: "booking_search", reason: msg("Top of the booking funnel and demand by date.") },
  { name: "bookable_viewed", display: "Bookable Item Viewed", description: msg("Service / property / slot detail viewed."), category: "booking", trigger: msg("Detail screen shown."), source: "mobile_sdk", priority: "high", properties: "bookable", automation: true, reason: msg("Interest signal for browse-abandonment automation.") },
  { name: "booking_started", display: "Booking Started", description: msg("User began booking."), category: "booking", trigger: msg("Booking form opened."), source: "mobile_sdk", priority: "high", properties: "bookable", conversion: true, automation: true, reason: msg("Booking abandonment automation.") },
  { name: "booking_completed", display: "Booking Completed", description: msg("Booking confirmed."), category: "revenue", trigger: msg("Your backend confirms the booking (and payment, if prepaid)."), source: "backend", priority: "critical", properties: "booking", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("Your conversion and revenue event."), sourceNote: BACKEND_PAYMENT },
  { name: "booking_cancelled", display: "Booking Cancelled", description: msg("Booking cancelled."), category: "booking", trigger: msg("Cancellation confirmed."), source: "backend", priority: "medium", properties: "booking_ref", revenue: true, automation: true, reason: msg("Net bookings and cancellation reasons."), sourceNote: msg("Providers and systems cancel too, not only the user.") },

  // ── Fintech ───────────────────────────────────────────────────────────────
  { name: "kyc_started", display: "KYC Started", description: msg("Identity verification began."), category: "fintech", trigger: msg("First KYC step shown."), source: "mobile_sdk", priority: "high", properties: "kyc", automation: true, reason: msg("KYC drop-off is the biggest leak in most fintech funnels.") },
  { name: "kyc_completed", display: "KYC Completed", description: msg("Identity verified."), category: "fintech", trigger: msg("Verification provider approves."), source: "backend", priority: "critical", properties: "kyc", conversion: true, attribution: true, automation: true, reason: msg("Verified users are the real acquisition outcome in fintech."), sourceNote: msg("Verification results come from your KYC provider, not the device.") },
  { name: "kyc_failed", display: "KYC Failed", description: msg("Verification rejected."), category: "fintech", trigger: msg("Verification provider rejects."), source: "backend", priority: "medium", properties: "kyc_failed", automation: true, reason: msg("Targeted help for users who failed verification."), sourceNote: msg("Send only a coarse reason code; never documents or raw identity data.") },
  { name: "account_created", display: "Account Created", description: msg("Wallet / account opened."), category: "fintech", trigger: msg("Core banking / ledger creates the account."), source: "backend", priority: "high", properties: "account", conversion: true, reason: msg("Account opening rate."), sourceNote: msg("Accounts are created in your ledger.") },
  { name: "deposit_completed", display: "Deposit Completed", description: msg("Funds added."), category: "fintech", trigger: msg("Ledger confirms the deposit."), source: "backend", priority: "critical", properties: "money_movement", conversion: true, attribution: true, automation: true, reason: msg("First funded account is the usual fintech activation."), sourceNote: msg("Money movement is confirmed only by your ledger.") },
  { name: "transfer_completed", display: "Transfer Completed", description: msg("Transfer / payment sent."), category: "fintech", trigger: msg("Ledger confirms the transfer."), source: "backend", priority: "high", properties: "money_movement", conversion: true, revenue: true, automation: true, reason: msg("Core usage and fee revenue."), sourceNote: msg("Money movement is confirmed only by your ledger.") },

  // ── EdTech ────────────────────────────────────────────────────────────────
  { name: "course_viewed", display: "Course Viewed", description: msg("Course page viewed."), category: "learning", trigger: msg("Course detail shown."), source: "mobile_sdk", priority: "medium", properties: "course", automation: true, reason: msg("Interest by subject; browse abandonment.") },
  { name: "course_started", display: "Course Started", description: msg("User enrolled / started a course."), category: "learning", trigger: msg("Enrolment confirmed."), source: "mobile_sdk", priority: "high", properties: "course", conversion: true, automation: true, reason: msg("Enrolment conversion.") },
  { name: "lesson_started", display: "Lesson Started", description: msg("Lesson opened."), category: "learning", trigger: msg("Lesson player opened."), source: "mobile_sdk", priority: "medium", properties: "lesson", reason: msg("Lesson completion rate.") },
  { name: "lesson_completed", display: "Lesson Completed", description: msg("Lesson finished."), category: "learning", trigger: msg("Lesson marked complete."), source: "mobile_sdk", priority: "critical", properties: "lesson", automation: true, reason: msg("Learning progress is the value users come for.") },
  { name: "course_completed", display: "Course Completed", description: msg("Course finished."), category: "learning", trigger: msg("All lessons complete (your backend decides)."), source: "backend", priority: "high", properties: "course", automation: true, reason: msg("Completion drives renewals and referrals."), sourceNote: msg("Course completion is computed from progress stored on your server.") },

  // ── Healthcare ────────────────────────────────────────────────────────────
  { name: "provider_viewed", display: "Provider Viewed", description: msg("Doctor / clinic profile viewed."), category: "health", trigger: msg("Provider profile shown."), source: "mobile_sdk", priority: "medium", properties: "provider", reason: msg("Demand by specialty (broad categories only).") },
  { name: "appointment_booking_started", display: "Appointment Booking Started", description: msg("User began booking."), category: "health", trigger: msg("Booking form opened."), source: "mobile_sdk", priority: "high", properties: "provider", automation: true, reason: msg("Booking abandonment follow-up.") },
  { name: "appointment_booked", display: "Appointment Booked", description: msg("Appointment confirmed."), category: "revenue", trigger: msg("Your backend confirms the appointment."), source: "backend", priority: "critical", properties: "appointment", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("Your conversion event."), sourceNote: msg("Confirmation and payment happen on your server.") },
  { name: "appointment_cancelled", display: "Appointment Cancelled", description: msg("Appointment cancelled."), category: "health", trigger: msg("Cancellation confirmed."), source: "backend", priority: "medium", properties: "appointment_ref", automation: true, reason: msg("Cancellation and no-show analysis."), sourceNote: msg("Providers cancel too.") },
  { name: "consultation_completed", display: "Consultation Completed", description: msg("Visit or consultation took place."), category: "health", trigger: msg("Provider closes the consultation."), source: "backend", priority: "high", properties: "appointment_ref", automation: true, reason: msg("Delivered care is the value; drives follow-up reminders."), sourceNote: msg("Only the provider system knows the visit happened.") },

  // ── Gaming ────────────────────────────────────────────────────────────────
  { name: "tutorial_completed", display: "Tutorial Completed", description: msg("Tutorial finished."), category: "gaming", trigger: msg("Last tutorial step."), source: "mobile_sdk", priority: "high", properties: null, automation: true, reason: msg("Day-1 retention depends on tutorial completion.") },
  { name: "level_started", display: "Level Started", description: msg("Level began."), category: "gaming", trigger: msg("Level loads."), source: "mobile_sdk", priority: "medium", properties: "level", reason: msg("Difficulty and drop-off by level.") },
  { name: "level_completed", display: "Level Completed", description: msg("Level won."), category: "gaming", trigger: msg("Level success screen."), source: "mobile_sdk", priority: "high", properties: "level", automation: true, reason: msg("Core progression.") },
  { name: "level_failed", display: "Level Failed", description: msg("Level lost."), category: "gaming", trigger: msg("Level fail screen."), source: "mobile_sdk", priority: "medium", properties: "level", reason: msg("Finds frustrating levels.") },
  { name: "in_app_purchase_completed", display: "In-App Purchase Completed", description: msg("Store purchase verified."), category: "revenue", trigger: msg("Your server validates the store receipt."), source: "backend", priority: "critical", properties: "iap", conversion: true, revenue: true, attribution: true, automation: true, reason: msg("IAP revenue for ROAS and LTV."), sourceNote: msg("Validate receipts server-side; client-reported purchases are easy to fake.") },
  { name: "ad_impression", display: "Ad Impression", description: msg("An ad was shown."), category: "revenue", trigger: msg("Ad network impression callback."), source: "mobile_sdk", priority: "medium", properties: "ad", revenue: true, reason: msg("Ad-funded revenue per user.") },
  { name: "achievement_unlocked", display: "Achievement Unlocked", description: msg("Achievement earned."), category: "gaming", trigger: msg("Achievement granted."), source: "mobile_sdk", priority: "low", properties: "achievement", reason: msg("Engagement depth.") },

  // ── Social / content ──────────────────────────────────────────────────────
  { name: "profile_completed", display: "Profile Completed", description: msg("Profile filled in."), category: "onboarding", trigger: msg("Profile saved with required fields."), source: "mobile_sdk", priority: "medium", properties: null, automation: true, reason: msg("Complete profiles retain better.") },
  { name: "content_viewed", display: "Content Viewed", description: msg("Post / video / article viewed."), category: "engagement", trigger: msg("Content shown for more than ~2 seconds."), source: "mobile_sdk", priority: "medium", properties: "content", reason: msg("Consumption side of engagement.") },
  { name: "content_created", display: "Content Created", description: msg("User published content."), category: "engagement", trigger: msg("Post published."), source: "mobile_sdk", priority: "high", properties: "content_create", automation: true, reason: msg("Creators drive network value.") },
  { name: "content_liked", display: "Content Liked", description: msg("Like / reaction."), category: "engagement", trigger: msg("Reaction saved."), source: "mobile_sdk", priority: "low", properties: "content", reason: msg("Lightweight engagement signal.") },
  { name: "comment_posted", display: "Comment Posted", description: msg("Comment added."), category: "engagement", trigger: msg("Comment saved."), source: "mobile_sdk", priority: "medium", properties: "content", reason: msg("Meaningful interaction.") },
  { name: "user_followed", display: "User Followed", description: msg("User followed another user."), category: "social", trigger: msg("Follow saved."), source: "mobile_sdk", priority: "medium", properties: "follow", automation: true, reason: msg("Graph density predicts retention.") },
  { name: "message_sent", display: "Message Sent", description: msg("Direct message sent."), category: "social", trigger: msg("Message delivered to server."), source: "mobile_sdk", priority: "medium", properties: "message", reason: msg("Conversation activity.") },
  { name: "content_shared", display: "Content Shared", description: msg("Content shared outside the app."), category: "growth", trigger: msg("Share sheet completed."), source: "mobile_sdk", priority: "medium", properties: "share", attribution: true, reason: msg("Viral loop measurement.") },

  // ── SaaS ──────────────────────────────────────────────────────────────────
  { name: "workspace_created", display: "Workspace Created", description: msg("Team / workspace created."), category: "onboarding", trigger: msg("Workspace saved."), source: "backend", priority: "high", properties: "workspace", conversion: true, automation: true, reason: msg("Account-level activation for B2B."), sourceNote: msg("Workspaces are created server-side.") },
  { name: "teammate_invited", display: "Teammate Invited", description: msg("Invitation sent."), category: "growth", trigger: msg("Invite sent."), source: "mobile_sdk", priority: "high", properties: "invite", automation: true, reason: msg("Multi-user accounts retain far better.") },
  { name: "feature_used", display: "Feature Used", description: msg("Core feature used."), category: "engagement", trigger: msg("Key feature action completed."), source: "mobile_sdk", priority: "high", properties: "feature", reason: msg("Feature adoption and depth of use.") },

  // ── Lead generation ───────────────────────────────────────────────────────
  { name: "lead_form_started", display: "Lead Form Started", description: msg("Lead form opened."), category: "lead", trigger: msg("Form opened."), source: "mobile_sdk", priority: "medium", properties: "lead_form", automation: true, reason: msg("Form abandonment follow-up.") },
  { name: "lead_submitted", display: "Lead Submitted", description: msg("Lead form submitted."), category: "lead", trigger: msg("Your server accepts the lead."), source: "backend", priority: "critical", properties: "lead", conversion: true, attribution: true, automation: true, reason: msg("Your conversion event."), sourceNote: msg("Count leads your server accepted, not form taps that may fail.") },
  { name: "lead_qualified", display: "Lead Qualified", description: msg("Sales qualified the lead."), category: "lead", trigger: msg("CRM status changes to qualified."), source: "backend", priority: "high", properties: "lead_qualified", conversion: true, revenue: true, attribution: true, reason: msg("Optimise campaigns on lead quality, not volume."), sourceNote: msg("Qualification happens in your CRM.") },

  // ── Growth loops ──────────────────────────────────────────────────────────
  { name: "referral_link_shared", display: "Referral Link Shared", description: msg("User shared a referral link."), category: "growth", trigger: msg("Share completed."), source: "mobile_sdk", priority: "medium", properties: "referral_share", attribution: true, reason: msg("Top of the referral loop.") },
  { name: "referral_completed", display: "Referral Completed", description: msg("A referred user qualified."), category: "growth", trigger: msg("Your backend credits the referral."), source: "backend", priority: "high", properties: "referral", conversion: true, attribution: true, automation: true, reason: msg("Referral programme ROI."), sourceNote: msg("Referral qualification and rewards are decided by your server.") },
  { name: "reward_earned", display: "Reward Earned", description: msg("Points / cashback earned."), category: "growth", trigger: msg("Ledger credits the reward."), source: "backend", priority: "medium", properties: "reward", automation: true, reason: msg("Loyalty engagement."), sourceNote: msg("Rewards balances live on your server.") },
  { name: "reward_redeemed", display: "Reward Redeemed", description: msg("Reward redeemed."), category: "growth", trigger: msg("Redemption confirmed."), source: "backend", priority: "medium", properties: "reward", automation: true, reason: msg("Loyalty value delivered."), sourceNote: msg("Redemptions are confirmed by your server.") },
];

export const EVENT_LIBRARY: Record<string, EventDefinition> = Object.fromEntries(defs.map((d) => [d.name, d]));

export function getEventDefinition(name: string): EventDefinition {
  const d = EVENT_LIBRARY[name];
  if (!d) throw new Error(`Unknown event in library: ${name}`);
  return d;
}
