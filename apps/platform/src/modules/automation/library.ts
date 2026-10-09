/**
 * Flows library: ready-made lifecycle flows for a consumer app (welcome
 * series, cart and checkout recovery, trial to paid, win-back, …). A template
 * is a definition in the exact shape createAutomation accepts, built from the
 * events the person maps to its slots (or the best match among the events the
 * app sends or plans to send), with its copy in English or Arabic. Applying
 * one always creates a draft; nothing is sent until someone activates it.
 *
 * Only what the engine already runs: event and audience-entered triggers,
 * waits, branch conditions, push, email, in-app and WhatsApp (an approved
 * template from the person's own WhatsApp account), goals and exit events.
 * Inactivity and "bought before, not lately" flows start from an audience
 * (created with the flow, as a draft), because an event-triggered flow can't
 * notice that something stopped happening. Copy uses no {{user.x}} tokens:
 * a missing property renders as nothing. Pure.
 */
import type { z } from "zod";
import { makeT, msg, type T } from "@/i18n/translate";
import type { AudienceNode } from "@/modules/audiences/definition";
import type { definitionSchema } from "./definition";

type DefinitionInput = z.input<typeof definitionSchema>;

export const FLOW_CATEGORIES = {
  onboarding: msg("Onboarding"),
  conversion: msg("Conversion"),
  subscription: msg("Subscriptions"),
  post_purchase: msg("Post-purchase"),
  retention: msg("Retention"),
} as const;
export type FlowCategory = keyof typeof FLOW_CATEGORIES;

/** What a flow is for; its definition's conversion goal measures it. */
export const FLOW_GOALS = {
  activation: msg("Activation"),
  first_purchase: msg("First purchase"),
  recovery: msg("Recover lost sales"),
  subscription: msg("Paid subscriptions"),
  repeat: msg("Repeat purchases"),
  advocacy: msg("Reviews and referrals"),
  reactivation: msg("Bring users back"),
} as const;
export type FlowGoal = keyof typeof FLOW_GOALS;

export type FlowChannel = "push" | "email" | "in_app" | "whatsapp";
export const CHANNEL_LABELS: Record<FlowChannel, string> = { push: msg("Push"), email: msg("Email"), in_app: msg("In-app"), whatsapp: "WhatsApp" };

/**
 * The events a template uses. `defaults` are names from the event library
 * (src/modules/implementation/catalog/events.ts), most likely first, except
 * where `custom` says the library has none; `aliases` are other common names
 * for the same moment. The suggestion is the first default or alias the app
 * already sends, else the first one in its tracking plan, else the first default.
 */
export const EVENT_SLOTS = {
  signup: { label: msg("Sign-up event"), defaults: ["signup_completed", "account_created"], aliases: ["sign_up", "registration_completed", "user_registered"] },
  key_action: { label: msg("Key action (what a set-up user does)"), defaults: ["onboarding_completed", "profile_completed", "tutorial_completed"], aliases: [] },
  product_view: { label: msg("Product viewed event"), defaults: ["product_viewed"], aliases: ["view_item", "product_view", "item_viewed"] },
  wishlist: { label: msg("Added to wishlist event"), defaults: ["wishlist_added"], aliases: ["add_to_wishlist", "wishlist_item_added"] },
  cart: { label: msg("Added to cart event"), defaults: ["product_added_to_cart"], aliases: ["add_to_cart", "added_to_cart", "cart_item_added"] },
  checkout: { label: msg("Checkout started event"), defaults: ["checkout_started"], aliases: ["begin_checkout", "checkout_begun"] },
  purchase: {
    label: msg("Purchase event"),
    defaults: ["purchase_completed", "order_completed", "in_app_purchase_completed", "booking_completed", "subscription_started"],
    aliases: ["purchase", "order_placed", "order_created"],
  },
  delivered: { label: msg("Order delivered event"), defaults: ["order_delivered"], aliases: ["delivery_completed"] },
  review: { label: msg("Review event"), defaults: ["review_submitted"], aliases: ["rating_submitted", "review_posted"] },
  referral: { label: msg("Invite shared event"), defaults: ["referral_link_shared"], aliases: ["invite_sent", "referral_shared"] },
  app_open: { label: msg("App opened event"), defaults: ["app_opened"], aliases: ["app_open", "session_started"] },
  feature: { label: msg("Feature used event"), defaults: ["feature_used"], aliases: [] },
  kyc_start: { label: msg("Verification started event"), defaults: ["kyc_started"], aliases: ["verification_started"] },
  kyc_done: { label: msg("Verification completed event"), defaults: ["kyc_completed"], aliases: ["verification_completed"] },
  trial: { label: msg("Trial started event"), defaults: ["trial_started"], aliases: ["start_trial", "free_trial_started"] },
  paywall: { label: msg("Paywall viewed event"), defaults: ["paywall_viewed"], aliases: ["paywall_shown"] },
  subscribe: { label: msg("Subscription started event"), defaults: ["subscription_started", "in_app_purchase_completed"], aliases: ["subscribed"] },
  renewal: { label: msg("Subscription renewed event"), defaults: ["subscription_renewed"], aliases: ["subscription_payment_succeeded"] },
  payment_failed: { label: msg("Payment failed event"), defaults: ["payment_failed"], aliases: ["subscription_payment_failed", "billing_failed"], custom: true },
  sub_ended: { label: msg("Subscription ended event"), defaults: ["subscription_expired", "subscription_cancelled"], aliases: ["subscription_ended"] },
} as const satisfies Record<string, { label: string; defaults: readonly string[]; aliases: readonly string[]; custom?: boolean }>;
export type EventSlot = keyof typeof EVENT_SLOTS;
type Events = Record<EventSlot, string>;

export type WhatsAppStepInput = { type: "whatsapp"; template: string; language: string; bodyParams: string[]; headerParams: string[] };

/** What a template builds besides its events: the audience it starts from, and the WhatsApp template chosen. */
export interface BuildExtras {
  audienceId: string;
  whatsapp: WhatsAppStepInput;
}

/** An audience a template creates (as a draft) and starts from. */
export interface TemplateAudience {
  name: string;
  description: string;
  definition: AudienceNode;
}

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  category: FlowCategory;
  goal: FlowGoal;
  channels: readonly FlowChannel[];
  /** Events it needs; without `audience`, the first one triggers the flow. */
  events: readonly EventSlot[];
  /** Starts when someone enters this audience, created with the flow. */
  audience?: (e: Events, t: T) => TemplateAudience;
  build: (e: Events, t: T, x: BuildExtras) => DefinitionInput;
}

/** "Did not do `event` since the trigger": the condition that keeps a reminder relevant. */
const notSince = (event: string) => ({ type: "event", event, did: false, sinceTrigger: true });
/** Started from the audience the template creates. */
const entered = (x: BuildExtras) => ({ type: "audience_entered" as const, audienceId: x.audienceId });

export const FLOW_TEMPLATES = [
  // ── Onboarding ─────────────────────────────────────────────────────────────
  {
    id: "welcome_series",
    name: msg("Welcome series"),
    description: msg("Greets new users right after sign-up, sends a getting-started email the next day and a tips message three days later."),
    category: "onboarding",
    goal: "activation",
    channels: ["push", "email", "in_app"],
    events: ["signup", "key_action"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.signup },
      entry: { mode: "once", cooldownHours: 0 },
      // Every new user gets the whole series; the goal only measures it.
      goal: { event: e.key_action, withinDays: 7, stopOnConversion: false },
      steps: [
        { type: "push", title: t("Welcome aboard!"), body: t("Thanks for signing up. Take a quick look around, your first steps only take a minute.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Getting started"), body: t("Welcome! Here are a few things to do first: complete your profile, explore what's new and turn on notifications so you never miss an update.") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "in_app", title: t("Need a hand?"), body: t("Here are a few tips to get the most out of the app."), buttonText: t("Show me") },
      ],
    }),
  },
  {
    id: "onboarding_nudge",
    name: msg("Onboarding nudge"),
    description: msg("Reminds people who signed up but haven't done the key action yet: a push after one day, an email two days later. Stops as soon as they do it."),
    category: "onboarding",
    goal: "activation",
    channels: ["push", "email"],
    events: ["signup", "key_action"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.signup },
      entry: { mode: "once", cooldownHours: 0 },
      goal: { event: e.key_action, withinDays: 7, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "days" },
        { type: "branch", condition: notSince(e.key_action), else: "exit" },
        { type: "push", title: t("You're almost there"), body: t("Finish setting up to unlock everything the app has to offer.") },
        { type: "delay", amount: 2, unit: "days" },
        { type: "branch", condition: notSince(e.key_action), else: "exit" },
        { type: "email", subject: t("Finish setting up your account"), body: t("You signed up a few days ago but haven't finished getting started. It only takes a minute, and we're here if you need help.") },
      ],
    }),
  },
  {
    id: "kyc_completion",
    name: msg("Finish identity verification"),
    description: msg("For finance apps: reminds people who started identity verification and didn't finish, with a push after two hours and an email the next day. Stops once they're verified."),
    category: "onboarding",
    goal: "activation",
    channels: ["push", "email"],
    events: ["kyc_start", "kyc_done"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.kyc_start },
      entry: { mode: "every_time", cooldownHours: 72 },
      goal: { event: e.kyc_done, withinDays: 7, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 2, unit: "hours" },
        { type: "push", title: t("Your verification is almost done"), body: t("Pick up where you left off. It takes a few minutes and unlocks your full account.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Finish verifying your identity"), body: t("You started verifying your identity but didn't finish. Keep your ID card or passport at hand and complete the last steps in the app. It takes a few minutes.") },
      ],
    }),
  },
  {
    id: "feature_adoption",
    name: msg("Feature discovery"),
    description: msg("Shows set-up users a feature they haven't tried yet: an in-app message after three days and a push four days later. Stops once they use it."),
    category: "onboarding",
    goal: "activation",
    channels: ["in_app", "push"],
    events: ["key_action", "feature"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.key_action },
      entry: { mode: "once", cooldownHours: 0 },
      goal: { event: e.feature, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 3, unit: "days" },
        { type: "in_app", title: t("Have you tried this yet?"), body: t("There's more you can do in the app. Take a quick tour of a feature people use every week."), buttonText: t("Take the tour") },
        { type: "delay", amount: 4, unit: "days" },
        { type: "push", title: t("One more thing to try"), body: t("Get more done with a feature you haven't used yet. Open the app to try it.") },
      ],
    }),
  },
  // ── Conversion ─────────────────────────────────────────────────────────────
  {
    id: "first_purchase",
    name: msg("First purchase nudge"),
    description: msg("Encourages new users who haven't bought yet: a push two days after sign-up and an email three days later. Add your welcome offer to the copy if you run one."),
    category: "conversion",
    goal: "first_purchase",
    channels: ["push", "email"],
    events: ["signup", "purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.signup },
      entry: { mode: "once", cooldownHours: 0 },
      goal: { event: e.purchase, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 2, unit: "days" },
        { type: "push", title: t("Your first order is a few taps away"), body: t("Browse today's picks and order when you're ready. We're here if you need help.") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "email", subject: t("Ready for your first order?"), body: t("Thanks for joining. Everything is ready for your first order: browse, add what you like to your cart and check out in a few steps.") },
      ],
    }),
  },
  {
    id: "browse_abandonment",
    name: msg("Browse abandonment"),
    description: msg("Follows up when someone views a product but doesn't add it to the cart: a push after three hours and an in-app message the next day. At most every three days."),
    category: "conversion",
    goal: "first_purchase",
    channels: ["push", "in_app"],
    events: ["product_view", "cart", "purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.product_view },
      entry: { mode: "every_time", cooldownHours: 72 },
      exitEvent: e.cart,
      goal: { event: e.purchase, withinDays: 3, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 3, unit: "hours" },
        { type: "push", title: t("Still thinking it over?"), body: t("Take another look at what caught your eye and add it to your cart when you're ready.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "in_app", title: t("Pick up where you left off"), body: t("The products you viewed are one tap away."), buttonText: t("View products") },
      ],
    }),
  },
  {
    id: "wishlist_reminder",
    name: msg("Wishlist reminder"),
    description: msg("Reminds people about items they saved to their wishlist and haven't bought: a push after three days and an email four days later."),
    category: "conversion",
    goal: "first_purchase",
    channels: ["push", "email"],
    events: ["wishlist", "purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.wishlist },
      entry: { mode: "every_time", cooldownHours: 168 },
      goal: { event: e.purchase, withinDays: 7, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 3, unit: "days" },
        { type: "push", title: t("Still on your wishlist"), body: t("The items you saved are waiting for you. Order them whenever you're ready.") },
        { type: "delay", amount: 4, unit: "days" },
        { type: "email", subject: t("Your saved items are waiting"), body: t("You saved a few items to your wishlist. Open the app to take another look and order the ones you love.") },
      ],
    }),
  },
  {
    id: "abandoned_cart",
    name: msg("Abandoned cart"),
    description: msg("Reminds people who added something to their cart but didn't start checkout: a push after one hour, an email the next day. Stops when they check out or buy."),
    category: "conversion",
    goal: "recovery",
    channels: ["push", "email"],
    events: ["cart", "checkout", "purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.cart },
      entry: { mode: "every_time", cooldownHours: 24 },
      exitEvent: e.checkout,
      goal: { event: e.purchase, withinDays: 3, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "hours" },
        { type: "push", title: t("You left something in your cart"), body: t("Your items are still waiting. Complete your order before they're gone.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Your cart is waiting"), body: t("You added items to your cart but didn't check out. They're saved for you, so come back and complete your order whenever you're ready.") },
      ],
    }),
  },
  {
    id: "cart_whatsapp",
    name: msg("Cart reminder on push and WhatsApp"),
    description: msg("Reminds people who left items in their cart: a push after one hour, then your approved WhatsApp template the next day. Stops when they check out or buy."),
    category: "conversion",
    goal: "recovery",
    channels: ["push", "whatsapp"],
    events: ["cart", "checkout", "purchase"],
    build: (e, t, x) => ({
      trigger: { type: "event", event: e.cart },
      entry: { mode: "every_time", cooldownHours: 24 },
      exitEvent: e.checkout,
      goal: { event: e.purchase, withinDays: 3, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "hours" },
        { type: "push", title: t("You left something in your cart"), body: t("Your items are still waiting. Complete your order before they're gone.") },
        { type: "delay", amount: 1, unit: "days" },
        x.whatsapp,
      ],
    }),
  },
  {
    id: "checkout_recovery",
    name: msg("Checkout without an order"),
    description: msg("Follows up when someone starts checkout (or their payment fails) and no order comes through: a push after 30 minutes, an email the next day. Stops when they buy."),
    category: "conversion",
    goal: "recovery",
    channels: ["push", "email"],
    events: ["checkout", "purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.checkout },
      entry: { mode: "every_time", cooldownHours: 24 },
      goal: { event: e.purchase, withinDays: 2, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 30, unit: "minutes" },
        { type: "push", title: t("Your order isn't complete yet"), body: t("Tap to finish your order, it only takes a moment.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Complete your order"), body: t("It looks like your order wasn't completed. If your payment didn't go through, you can try again or choose another payment method.") },
      ],
    }),
  },
  // ── Subscriptions ──────────────────────────────────────────────────────────
  {
    id: "trial_conversion",
    name: msg("Trial to paid"),
    description: msg("Helps trial users subscribe before the trial ends, timed for a 7-day trial: tips on day 2, a push on day 5 and an email on day 6. Stops when they subscribe."),
    category: "subscription",
    goal: "subscription",
    channels: ["in_app", "push", "email"],
    events: ["trial", "subscribe"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.trial },
      entry: { mode: "once", cooldownHours: 0 },
      goal: { event: e.subscribe, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 2, unit: "days" },
        { type: "in_app", title: t("Make the most of your trial"), body: t("Try the features subscribers use most while your trial is active."), buttonText: t("Explore features") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "push", title: t("Your trial ends soon"), body: t("Subscribe now to keep everything you've set up without interruption.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Your trial ends tomorrow"), body: t("Your trial ends tomorrow. Subscribe today to keep your progress and full access. You can cancel at any time.") },
      ],
    }),
  },
  {
    id: "paywall_follow_up",
    name: msg("Paywall follow-up"),
    description: msg("Follows up a day after someone views your plans without subscribing, with one push. At most once a week per person."),
    category: "subscription",
    goal: "subscription",
    channels: ["push"],
    events: ["paywall", "subscribe"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.paywall },
      entry: { mode: "every_time", cooldownHours: 168 },
      goal: { event: e.subscribe, withinDays: 3, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "days" },
        { type: "push", title: t("Still deciding?"), body: t("See everything a subscription unlocks and choose the plan that suits you.") },
      ],
    }),
  },
  {
    id: "payment_failed",
    name: msg("Failed payment recovery"),
    description: msg("Asks subscribers to update their payment method when a renewal fails: a push right away, an email the next day and an in-app message two days later. Stops once the renewal goes through."),
    category: "subscription",
    goal: "recovery",
    channels: ["push", "email", "in_app"],
    events: ["payment_failed", "renewal"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.payment_failed },
      entry: { mode: "every_time", cooldownHours: 24 },
      goal: { event: e.renewal, withinDays: 7, stopOnConversion: true },
      steps: [
        { type: "push", title: t("Your payment didn't go through"), body: t("Update your payment method to keep your subscription active.") },
        { type: "delay", amount: 1, unit: "days" },
        { type: "email", subject: t("Update your payment method"), body: t("We couldn't process the payment for your subscription. Update your card or choose another payment method to keep your access without interruption.") },
        { type: "delay", amount: 2, unit: "days" },
        { type: "in_app", title: t("Your subscription needs attention"), body: t("Your last payment failed. Update your payment method to keep your access."), buttonText: t("Update payment") },
      ],
    }),
  },
  {
    id: "subscription_win_back",
    name: msg("Expired subscription win-back"),
    description: msg("Invites people whose subscription ended to come back: a push a day later and an email after a week. Stops when they subscribe again."),
    category: "subscription",
    goal: "subscription",
    channels: ["push", "email"],
    events: ["sub_ended", "subscribe"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.sub_ended },
      entry: { mode: "every_time", cooldownHours: 720 },
      goal: { event: e.subscribe, withinDays: 30, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "days" },
        { type: "push", title: t("Your subscription has ended"), body: t("Renew any time to pick up right where you left off.") },
        { type: "delay", amount: 7, unit: "days" },
        { type: "email", subject: t("Come back to everything you had"), body: t("Your subscription ended last week. Renew today to get your full access back and continue where you stopped.") },
      ],
    }),
  },
  // ── Post-purchase ──────────────────────────────────────────────────────────
  {
    id: "post_purchase",
    name: msg("Thank-you and review request"),
    description: msg("Thanks people right after a purchase and asks for a review three days later, unless they have already left one. At most once a month per person."),
    category: "post_purchase",
    goal: "advocacy",
    channels: ["push"],
    events: ["purchase", "review"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.purchase },
      entry: { mode: "every_time", cooldownHours: 720 },
      goal: { event: e.review, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "push", title: t("Thank you for your order!"), body: t("We appreciate your purchase and hope you enjoy it.") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "branch", condition: notSince(e.review), else: "exit" },
        { type: "push", title: t("How was your order?"), body: t("Tell us what you think. Your review helps other customers and helps us improve.") },
      ],
    }),
  },
  {
    id: "delivery_rating",
    name: msg("Rating after delivery"),
    description: msg("Asks for a rating the day after an order is delivered, while the experience is fresh. Skipped if they already left a review. At most once a month per person."),
    category: "post_purchase",
    goal: "advocacy",
    channels: ["in_app"],
    events: ["delivered", "review"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.delivered },
      entry: { mode: "every_time", cooldownHours: 720 },
      goal: { event: e.review, withinDays: 7, stopOnConversion: true },
      steps: [
        { type: "delay", amount: 1, unit: "days" },
        { type: "in_app", title: t("Enjoying your order?"), body: t("If you're happy with it, a quick rating helps us a lot."), buttonText: t("Rate us") },
      ],
    }),
  },
  {
    id: "second_purchase",
    name: msg("Second order nudge"),
    description: msg("Reaches first-time buyers who haven't ordered again a week later: a push, then an in-app message three days later. Creates the audience it starts from."),
    category: "post_purchase",
    goal: "repeat",
    channels: ["push", "in_app"],
    events: ["purchase"],
    audience: (e, t) => ({
      name: t("One-time buyers, 7+ days"),
      description: t("Bought exactly once in the last 60 days, and not in the last 7. Created by the flows library."),
      definition: {
        type: "and",
        children: [
          { type: "event", event: e.purchase, did: true, countOp: "eq", count: 1, withinDays: 60, where: [] },
          { type: "event", event: e.purchase, did: false, countOp: "gte", count: 1, withinDays: 7, where: [] },
        ],
      },
    }),
    build: (e, t, x) => ({
      trigger: entered(x),
      entry: { mode: "every_time", cooldownHours: 0 },
      goal: { event: e.purchase, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "push", title: t("Time for another order?"), body: t("Your last order was a week ago. See what's new and order again in a few taps.") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "in_app", title: t("Order again"), body: t("Find what you ordered last time, and new picks we think you'll like."), buttonText: t("Order again") },
      ],
    }),
  },
  {
    id: "referral_ask",
    name: msg("Referral ask for loyal customers"),
    description: msg("Asks customers who reach three purchases in 90 days to invite a friend: an in-app message, then a push three days later. Creates the audience it starts from."),
    category: "post_purchase",
    goal: "advocacy",
    channels: ["in_app", "push"],
    events: ["purchase", "referral"],
    audience: (e, t) => ({
      name: t("Loyal customers, 3+ orders"),
      description: t("Bought at least 3 times in the last 90 days. Created by the flows library."),
      definition: { type: "event", event: e.purchase, did: true, countOp: "gte", count: 3, withinDays: 90, where: [] },
    }),
    build: (e, t, x) => ({
      trigger: entered(x),
      entry: { mode: "every_time", cooldownHours: 2160 },
      goal: { event: e.referral, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "in_app", title: t("Know someone who'd like this?"), body: t("Share the app with friends and family who'd enjoy it as much as you do."), buttonText: t("Invite a friend") },
        { type: "delay", amount: 3, unit: "days" },
        { type: "push", title: t("Share the app with a friend"), body: t("Know someone who'd enjoy it? Send them an invite from the app.") },
      ],
    }),
  },
  // ── Retention ──────────────────────────────────────────────────────────────
  {
    id: "win_back",
    name: msg("Win back inactive users"),
    description: msg("Reaches people who haven't used the app for 7 days, again at 14 and at 30 days, by push and email. Stops as soon as they come back. Creates the audience it starts from."),
    category: "retention",
    goal: "reactivation",
    channels: ["push", "email"],
    events: ["app_open"],
    audience: (_e, t) => ({
      name: t("Inactive for 7+ days"),
      description: t("Last seen more than 7 days ago. Created by the flows library."),
      definition: { type: "last_seen", op: "before_days", days: 7 },
    }),
    build: (e, t, x) => ({
      trigger: entered(x),
      entry: { mode: "every_time", cooldownHours: 0 },
      goal: { event: e.app_open, withinDays: 30, stopOnConversion: true },
      steps: [
        { type: "push", title: t("We miss you"), body: t("It's been a while. Come back and see what's new.") },
        { type: "delay", amount: 7, unit: "days" },
        { type: "branch", condition: { type: "last_seen", op: "before_days", days: 14 }, else: "exit" },
        { type: "email", subject: t("It's been a while"), body: t("We haven't seen you in a few weeks. A lot has changed since your last visit, so come back and take a look.") },
        { type: "delay", amount: 16, unit: "days" },
        { type: "branch", condition: { type: "last_seen", op: "before_days", days: 30 }, else: "exit" },
        { type: "push", title: t("There's something new for you"), body: t("A lot has changed since your last visit. Open the app to catch up.") },
      ],
    }),
  },
  {
    id: "lapsed_buyers",
    name: msg("Re-engage lapsed buyers"),
    description: msg("Reaches customers who bought in the past year but not in the last 30 days: a push, then an email a week later. Stops when they buy. Creates the audience it starts from."),
    category: "retention",
    goal: "repeat",
    channels: ["push", "email"],
    events: ["purchase"],
    audience: (e, t) => ({
      name: t("Lapsed buyers, 30+ days"),
      description: t("Bought in the last 365 days, but not in the last 30. Created by the flows library."),
      definition: {
        type: "and",
        children: [
          { type: "event", event: e.purchase, did: true, countOp: "gte", count: 1, withinDays: 365, where: [] },
          { type: "event", event: e.purchase, did: false, countOp: "gte", count: 1, withinDays: 30, where: [] },
        ],
      },
    }),
    build: (e, t, x) => ({
      trigger: entered(x),
      entry: { mode: "every_time", cooldownHours: 0 },
      goal: { event: e.purchase, withinDays: 14, stopOnConversion: true },
      steps: [
        { type: "push", title: t("Ready for your next order?"), body: t("It's been a month since your last order. See what's new since then.") },
        { type: "delay", amount: 7, unit: "days" },
        { type: "email", subject: t("We picked a few things for you"), body: t("It's been a while since your last order. Come back and discover what's new, we think you'll find something you like.") },
      ],
    }),
  },
] as const satisfies readonly FlowTemplate[];

export type FlowTemplateId = (typeof FLOW_TEMPLATES)[number]["id"];
export const FLOW_TEMPLATE_IDS = FLOW_TEMPLATES.map((f) => f.id) as [FlowTemplateId, ...FlowTemplateId[]];

export function getFlowTemplate(id: FlowTemplateId): FlowTemplate {
  return FLOW_TEMPLATES.find((f) => f.id === id)! as FlowTemplate;
}

export const needsWhatsApp = (tpl: FlowTemplate) => tpl.channels.includes("whatsapp");

/** What's known about the app's events: received in this environment, and in its published tracking plan (null: unknown). */
export interface KnownEvents {
  seen?: ReadonlySet<string> | null;
  planned?: ReadonlySet<string> | null;
}

/**
 * received: the environment got it in the last 90 days. planned: in the
 * tracking plan, not received yet. missing: neither. unknown: the reader
 * can see neither the events nor the plan.
 */
export type EventStatus = "received" | "planned" | "missing" | "unknown";

/**
 * The event suggested for each slot of a template: the first default or
 * alias the app already sends, else the first one in its tracking plan,
 * else the first default.
 */
export function suggestedEvents(template: FlowTemplate, known: KnownEvents | null = null): { slot: EventSlot; event: string; status: EventStatus }[] {
  const seen = known?.seen ?? null;
  const planned = known?.planned ?? null;
  return template.events.map((slot) => {
    const names: readonly string[] = [...EVENT_SLOTS[slot].defaults, ...EVENT_SLOTS[slot].aliases];
    const event = names.find((d) => seen?.has(d)) ?? names.find((d) => planned?.has(d)) ?? names[0];
    return { slot, event, status: eventStatus(event, known) };
  });
}

export function eventStatus(event: string, known: KnownEvents | null): EventStatus {
  if (known?.seen?.has(event)) return "received";
  if (known?.planned?.has(event)) return "planned";
  return known?.seen || known?.planned ? "missing" : "unknown";
}

const english = makeT(null);

/** Stands in for the audience a template creates, until it exists. */
export const PENDING_AUDIENCE_ID = "00000000-0000-4000-8000-000000000000";
/** Stands in for the WhatsApp template the person picks, in previews. */
export const PENDING_WHATSAPP = "choose_an_approved_template";

export interface FlowPlan {
  name: string;
  definition: DefinitionInput;
  /** The audience to create first; the definition's trigger points to PENDING_AUDIENCE_ID until then. */
  audience: TemplateAudience | null;
}

/**
 * The name, definition and (for audience-started flows) audience of a flow
 * from a template. `events` maps slots to event names; a slot left out or
 * empty gets its suggestion. Copy is in English unless `t` translates it
 * (it's stored as the flow's text). `whatsapp` is the approved template for
 * a WhatsApp step; without one, the step holds a placeholder that can't be
 * saved (fine for a preview).
 */
export function planFlowTemplate(
  id: FlowTemplateId,
  events: Partial<Record<string, unknown>> = {},
  t: T = english,
  known: KnownEvents | null = null,
  extras: { whatsapp?: Omit<WhatsAppStepInput, "type"> | null } = {},
): FlowPlan {
  const template = getFlowTemplate(id);
  const e = Object.fromEntries(Object.keys(EVENT_SLOTS).map((s) => [s, ""])) as Events;
  for (const { slot, event } of suggestedEvents(template, known)) {
    const given = events[slot];
    e[slot] = typeof given === "string" && given.trim() ? given.trim() : event;
  }
  const whatsapp: WhatsAppStepInput = { type: "whatsapp", ...(extras.whatsapp ?? { template: PENDING_WHATSAPP, language: "en", bodyParams: [], headerParams: [] }) };
  return {
    name: t(template.name),
    definition: template.build(e, t, { audienceId: PENDING_AUDIENCE_ID, whatsapp }),
    audience: template.audience ? template.audience(e, t) : null,
  };
}

/** Templates matching a search and filters. The search looks at names, descriptions (English and translated), channels and event names. */
export function filterFlowTemplates(
  filters: { q?: string | null; category?: string | null; goal?: string | null },
  t: T = english,
): FlowTemplate[] {
  const q = filters.q?.trim().toLowerCase() ?? "";
  return (FLOW_TEMPLATES as readonly FlowTemplate[]).filter((tpl) => {
    if (filters.category && tpl.category !== filters.category) return false;
    if (filters.goal && tpl.goal !== filters.goal) return false;
    if (!q) return true;
    const haystack = [
      tpl.name, t(tpl.name), tpl.description, t(tpl.description),
      FLOW_CATEGORIES[tpl.category], t(FLOW_CATEGORIES[tpl.category]), FLOW_GOALS[tpl.goal], t(FLOW_GOALS[tpl.goal]),
      ...tpl.channels.flatMap((c) => [CHANNEL_LABELS[c], t(CHANNEL_LABELS[c])]),
      ...tpl.events.flatMap((s) => [...EVENT_SLOTS[s].defaults, ...EVENT_SLOTS[s].aliases]),
    ].join(" ").toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}

/** Channel readiness in an environment: true connected, false not, null unknown (the reader can't see integrations). */
export type ChannelState = Record<FlowChannel, boolean | null>;

export type ReadinessIssue =
  | { kind: "event"; slot: EventSlot; event: string; status: "planned" | "missing" }
  | { kind: "channel"; channel: FlowChannel }
  | { kind: "whatsapp_template" }
  | { kind: "audience"; name: string }
  | { kind: "audience_permission" };

/**
 * What stands between a template and a working flow in this environment.
 * `blocking` issues stop it being created; the rest only stop it from
 * starting or sending until they're fixed.
 */
export function flowReadiness(
  template: FlowTemplate,
  ctx: { events: { slot: EventSlot; event: string; status: EventStatus }[]; channels: ChannelState; approvedWhatsAppTemplates: number | null; canManageAudiences: boolean; audienceName?: string },
): { issues: ReadinessIssue[]; blocking: boolean } {
  const issues: ReadinessIssue[] = [];
  for (const e of ctx.events) if (e.status === "planned" || e.status === "missing") issues.push({ kind: "event", slot: e.slot, event: e.event, status: e.status });
  for (const c of template.channels) if (ctx.channels[c] === false) issues.push({ kind: "channel", channel: c });
  const noTemplate = needsWhatsApp(template) && ctx.channels.whatsapp !== false && ctx.approvedWhatsAppTemplates === 0;
  if (noTemplate) issues.push({ kind: "whatsapp_template" });
  if (template.audience) issues.push(ctx.canManageAudiences ? { kind: "audience", name: ctx.audienceName ?? "" } : { kind: "audience_permission" });
  const blocking = (needsWhatsApp(template) && (ctx.channels.whatsapp === false || noTemplate)) || (!!template.audience && !ctx.canManageAudiences);
  return { issues, blocking };
}
