/**
 * Flows library: ready-made flows for a consumer app (welcome series,
 * abandoned cart, win-back, …). A template is a definition in the exact
 * shape createAutomation accepts, built from the events the person maps to
 * its slots (or common defaults from the event library), with its copy in
 * the reader's language. Applying one always creates a draft; nothing is sent
 * until someone activates it. Uses push, email and in-app only: WhatsApp needs
 * a template approved in the person's own WhatsApp account. Pure.
 */
import type { z } from "zod";
import { makeT, msg, type T } from "@/i18n/translate";
import type { definitionSchema } from "./definition";

type DefinitionInput = z.input<typeof definitionSchema>;

export const FLOW_CATEGORIES = {
  onboarding: msg("Onboarding"),
  conversion: msg("Conversion"),
  retention: msg("Retention"),
  post_purchase: msg("Post-purchase"),
} as const;
export type FlowCategory = keyof typeof FLOW_CATEGORIES;

/**
 * The events a template uses. `defaults` are names from the event library
 * (src/modules/implementation/catalog/events.ts), most likely first; the
 * first one the app already sends is suggested, else the first.
 */
export const EVENT_SLOTS = {
  signup: { label: msg("Sign-up event"), defaults: ["signup_completed", "account_created"] },
  key_action: { label: msg("Key action (what a set-up user does)"), defaults: ["onboarding_completed", "profile_completed", "tutorial_completed"] },
  cart: { label: msg("Added to cart event"), defaults: ["product_added_to_cart"] },
  checkout: { label: msg("Checkout started event"), defaults: ["checkout_started"] },
  purchase: { label: msg("Purchase event"), defaults: ["purchase_completed", "order_completed", "in_app_purchase_completed", "booking_completed", "subscription_started"] },
  review: { label: msg("Review event"), defaults: ["review_submitted"] },
  app_open: { label: msg("App opened event"), defaults: ["app_opened"] },
} as const satisfies Record<string, { label: string; defaults: readonly string[] }>;
export type EventSlot = keyof typeof EVENT_SLOTS;
type Events = Record<EventSlot, string>;

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  category: FlowCategory;
  channels: readonly ("push" | "email" | "in_app")[];
  /** Events it needs; the first one triggers the flow. */
  events: readonly EventSlot[];
  build: (e: Events, t: T) => DefinitionInput;
}

/** "Did not do `event` since the trigger": the condition that keeps a reminder relevant. */
const notSince = (event: string) => ({ type: "event", event, did: false, sinceTrigger: true });

export const FLOW_TEMPLATES = [
  {
    id: "welcome_series",
    name: msg("Welcome series"),
    description: msg("Greets new users right after sign-up, sends a getting-started email the next day and a tips message three days later."),
    category: "onboarding",
    channels: ["push", "email", "in_app"],
    events: ["signup"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.signup },
      entry: { mode: "once", cooldownHours: 0 },
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
    id: "abandoned_cart",
    name: msg("Abandoned cart"),
    description: msg("Reminds people who added something to their cart but didn't start checkout: a push after one hour, an email the next day. Stops when they check out or buy."),
    category: "conversion",
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
    id: "checkout_recovery",
    name: msg("Checkout without an order"),
    description: msg("Follows up when someone starts checkout (or their payment fails) and no order comes through: a push after 30 minutes, an email the next day. Stops when they buy."),
    category: "conversion",
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
  {
    id: "post_purchase",
    name: msg("Thank-you and review request"),
    description: msg("Thanks people right after a purchase and asks for a review three days later, unless they have already left one. At most once a month per person."),
    category: "post_purchase",
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
    id: "win_back",
    name: msg("Win back inactive users"),
    description: msg("Reaches people who haven't opened the app for 14 days after their last visit: a push, then an email a week later if they still haven't come back."),
    category: "retention",
    channels: ["push", "email"],
    events: ["app_open"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.app_open },
      entry: { mode: "every_time", cooldownHours: 0 },
      steps: [
        { type: "delay", amount: 14, unit: "days" },
        { type: "branch", condition: notSince(e.app_open), else: "exit" },
        { type: "push", title: t("We miss you"), body: t("It's been a while. Come back and see what's new.") },
        { type: "delay", amount: 7, unit: "days" },
        { type: "branch", condition: notSince(e.app_open), else: "exit" },
        { type: "email", subject: t("It's been a while"), body: t("We haven't seen you in a few weeks. A lot has changed since your last visit, so come back and take a look.") },
      ],
    }),
  },
  {
    id: "lapsed_buyers",
    name: msg("Re-engage lapsed buyers"),
    description: msg("Reaches customers who haven't bought again within 30 days of their last purchase: a push, then an email a week later if they still haven't."),
    category: "retention",
    channels: ["push", "email"],
    events: ["purchase"],
    build: (e, t) => ({
      trigger: { type: "event", event: e.purchase },
      entry: { mode: "every_time", cooldownHours: 0 },
      steps: [
        { type: "delay", amount: 30, unit: "days" },
        { type: "branch", condition: notSince(e.purchase), else: "exit" },
        { type: "push", title: t("Ready for your next order?"), body: t("It's been a month since your last order. See what's new since then.") },
        { type: "delay", amount: 7, unit: "days" },
        { type: "branch", condition: notSince(e.purchase), else: "exit" },
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

/**
 * The event suggested for each slot of a template: the first default the app
 * already sends (`seen`), else the first default. `seen` is null when the
 * reader can't see the app's events.
 */
export function suggestedEvents(template: FlowTemplate, seen: ReadonlySet<string> | null): { slot: EventSlot; event: string; seen: boolean | null }[] {
  return template.events.map((slot) => {
    const defaults: readonly string[] = EVENT_SLOTS[slot].defaults;
    const event = defaults.find((d) => seen?.has(d)) ?? defaults[0];
    return { slot, event, seen: seen ? seen.has(event) : null };
  });
}

const english = makeT(null);

/**
 * The name and definition of a flow from a template. `events` maps slots to
 * event names; a slot left out or empty gets its suggested default. Copy is
 * in English unless `t` translates it (it's stored as the flow's text).
 */
export function planFlowTemplate(id: FlowTemplateId, events: Partial<Record<string, unknown>> = {}, t: T = english, seen: ReadonlySet<string> | null = null): { name: string; definition: DefinitionInput } {
  const template = getFlowTemplate(id);
  const e = Object.fromEntries(Object.keys(EVENT_SLOTS).map((s) => [s, ""])) as Events;
  for (const { slot, event } of suggestedEvents(template, seen)) {
    const given = events[slot];
    e[slot] = typeof given === "string" && given.trim() ? given.trim() : event;
  }
  return { name: t(template.name), definition: template.build(e, t) };
}
