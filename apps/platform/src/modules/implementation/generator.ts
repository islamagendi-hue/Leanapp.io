/**
 * Business understanding → tracking plan.
 *
 * Pure function of (answers, app platforms). Deterministic, explainable rules
 * (generator id `rules@1`): every event, property and rule carries a reason.
 * An LLM-assisted generator can propose additions later, but its output must
 * pass through the same schema and human approval (docs/implementation-engine.md).
 */
import { classifyBusiness, type Classification } from "./classifier";
import { EVENT_LIBRARY, type EventCategory, type EventDefinition, type EventSource, type Priority } from "./catalog/events";
import {
  BASE_USER_PROPERTIES, CHANNEL_RULES, FEATURE_EVENTS, FEATURES, JOURNEY_PHRASES, MODEL_LABELS, MODEL_SUBSTITUTIONS, MODELS,
  USER_PROPERTY_LIBRARY, type AttributionChannel, type BusinessModel, type Feature, type UserPropertyDefinition,
} from "./catalog/models";
import { PROPERTY_SETS, type PropertySpec } from "./catalog/properties";
import type { Answers } from "./questions";

export const GENERATOR_ID = "rules@1";

export interface PlannedEvent {
  event_name: string;
  display_name: string;
  description: string;
  category: EventCategory | "custom";
  trigger: string;
  source: EventSource;
  priority: Priority;
  required: boolean;
  activation_relevance: boolean;
  conversion_relevance: boolean;
  revenue_relevance: boolean;
  attribution_relevance: boolean;
  automation_relevance: boolean;
  platforms: string[];
  reason: string;
  source_note: string | null;
  properties: PropertySpec[];
}

export type PlannedUserProperty = UserPropertyDefinition;

export interface PlannedAttributionRule {
  channel: string;
  parameters: string[];
  click_id_param: string | null;
  notes: string;
}

export interface GeneratedPlan {
  generator: string;
  business_model: BusinessModel;
  secondary_models: BusinessModel[];
  classification: Pick<Classification, "confidence" | "signals">;
  activation_event: string;
  north_star_event: string;
  revenue_event: string | null;
  events: PlannedEvent[];
  user_properties: PlannedUserProperty[];
  attribution_rules: PlannedAttributionRule[];
  journey_matches: { phrase: string; events: string[] }[];
  warnings: string[];
}

const CATEGORY_ORDER: (EventCategory | "custom")[] = [
  "lifecycle", "account", "onboarding", "discovery", "commerce", "marketplace", "booking", "learning", "health", "gaming",
  "social", "engagement", "fintech", "subscription", "revenue", "fulfilment", "lead", "growth", "messaging", "custom",
];
const MOBILE = new Set(["android", "ios", "react_native", "flutter", "web"]);

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

export function generatePlan(answers: Answers, appPlatforms: string[]): GeneratedPlan {
  const c = classifyBusiness(answers);
  const model = MODELS[c.primary];
  const warnings: string[] = [...(model.warnings ?? [])];
  const reasons = new Map<string, string[]>();
  const order: string[] = [];
  const subs = MODEL_SUBSTITUTIONS[c.primary] ?? {};

  const add = (name: string, reason: string) => {
    const n = subs[name] ?? name;
    if (!EVENT_LIBRARY[n]) return;
    if (!reasons.has(n)) {
      reasons.set(n, []);
      order.push(n);
    }
    const r = reasons.get(n)!;
    if (!r.includes(reason)) r.push(reason);
  };

  // 1. Lifecycle: every mobile app.
  for (const n of ["app_installed", "app_opened", "app_updated", "screen_viewed"]) add(n, "Captured for every app.");

  // 2. Account and onboarding.
  if (answers["app.has_signup"] === true) for (const n of ["signup_started", "signup_completed", "login_completed"]) add(n, "Users create accounts.");
  if (answers["app.has_onboarding"] === true) for (const n of FEATURE_EVENTS.onboarding) add(n, "You have an onboarding flow.");

  // 3. Business model(s).
  for (const n of model.events) add(n, `Core ${MODEL_LABELS[c.primary]} event.`);
  // Secondary models add their behaviour, but never a second revenue event when the primary model has one.
  for (const m of c.secondary)
    for (const n of MODELS[m].events) {
      if (model.revenueEvent && EVENT_LIBRARY[n]?.revenue) continue;
      add(n, `Your app also has ${MODEL_LABELS[m]} behaviour.`);
    }

  // 4. Product features.
  const features = new Set<Feature>(arr(answers["app.features"]).filter((f): f is Feature => (FEATURES as readonly string[]).includes(f)));
  for (const f of features) for (const n of FEATURE_EVENTS[f]) add(n, `Your app has ${f.replace(/_/g, " ")}.`);

  // 5. Monetization.
  const streams = arr(answers["monetization.streams"]);
  const monetized = streams.length > 0 && !streams.includes("none");
  if (streams.includes("subscriptions")) {
    for (const n of FEATURE_EVENTS.subscriptions) add(n, "You charge subscriptions.");
    if (answers["monetization.has_trial"] === true) add("trial_started", "You offer a free trial.");
  }
  if (streams.includes("iap")) add("in_app_purchase_completed", "You sell in-app purchases.");
  if (streams.includes("ads")) add("ad_impression", "You earn from advertising.");
  if (streams.includes("leads")) for (const n of ["lead_submitted", "lead_qualified"]) add(n, "You earn from leads.");
  if (answers["monetization.has_refunds"] === true) add("refund_completed", "You issue refunds, so net revenue needs them.");
  if (model.revenueEvent && monetized) add(model.revenueEvent, "Your revenue event.");

  // 6. Revenue event: the model's when present; otherwise the first revenue-bearing event.
  const included = () => order.filter((n) => reasons.has(n));
  let revenueEvent: string | null = null;
  if (monetized) {
    const preferred = model.revenueEvent ? (subs[model.revenueEvent] ?? model.revenueEvent) : null;
    revenueEvent = preferred && reasons.has(preferred) ? preferred : (included().find((n) => isPrimaryRevenue(EVENT_LIBRARY[n])) ?? null);
  }

  // 7. Natural-language journey → events (revenue mentions map to the plan's revenue event).
  const journeyText = [answers["journey.description"], answers["app.primary_action"], answers["app.first_action"]].filter((x) => typeof x === "string").join("\n");
  const journeyMatches: GeneratedPlan["journey_matches"] = [];
  const hits: { index: number; phrase: string; events: string[] }[] = [];
  for (const rule of JOURNEY_PHRASES) {
    if (rule.onlyFor && !rule.onlyFor.includes(c.primary) && !rule.onlyFor.some((m) => c.secondary.includes(m))) continue;
    const m = rule.pattern.exec(journeyText);
    if (m) hits.push({ index: m.index, phrase: m[0], events: rule.events });
  }
  hits.sort((x, y) => x.index - y.index);
  for (const h of hits) {
    const mapped = h.events.map((e) => {
      const n = subs[e] ?? e;
      const d = EVENT_LIBRARY[n];
      if (d && isPrimaryRevenue(d) && revenueEvent && n !== revenueEvent) return revenueEvent;
      if (d && isPrimaryRevenue(d) && !monetized) return null;
      return n;
    }).filter((x): x is string => !!x);
    for (const n of mapped) add(n, `Mentioned in your journey: “${h.phrase.trim()}”.`);
    if (mapped.length) journeyMatches.push({ phrase: h.phrase.trim(), events: [...new Set(mapped)] });
  }
  if (!revenueEvent && monetized) revenueEvent = included().find((n) => isPrimaryRevenue(EVENT_LIBRARY[n])) ?? null;

  // 8. Activation and north star (customer override wins; custom names become custom events).
  const customEvents = new Map<string, PlannedEvent>();
  const pickEvent = (key: string, fallback: string, role: "activation" | "north star"): string => {
    const v = answers[key];
    const name = typeof v === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(v) ? v : fallback;
    if (EVENT_LIBRARY[name]) add(name, `Your ${role} event.`);
    else if (!customEvents.has(name)) customEvents.set(name, customEvent(name, role));
    return name;
  };
  const activation = pickEvent("value.activation_event", subs[model.activationCandidates[0]] ?? model.activationCandidates[0] ?? "feature_used", "activation");
  const northStar = pickEvent("value.north_star_event", subs[model.northStarCandidates[0]] ?? model.northStarCandidates[0] ?? activation, "north star");

  // 9. Build event specs.
  const platformsFor = (source: EventSource): string[] => {
    const mobile = appPlatforms.filter((p) => MOBILE.has(p));
    if (source === "backend") return ["backend"];
    if (source === "both") return [...mobile, "backend"];
    return mobile.length ? mobile : ["android", "ios"];
  };
  const overrides = { ...(model.propertyOverrides ?? {}) };
  const food = c.primary === "delivery" && c.food;
  const rename = (s: string) => (food ? s.replace(/^vendor_/, "restaurant_") : s);

  const events: PlannedEvent[] = included().map((n) => {
    const d = EVENT_LIBRARY[n];
    const setKey = overrides[n] ?? d.properties;
    const props = (setKey ? PROPERTY_SETS[setKey] : []).map((p) => ({ ...p, name: rename(p.name) }));
    const isRevenue = !!d.revenue;
    const required = d.priority === "critical" || d.priority === "high" || n === activation || n === northStar || n === revenueEvent;
    return {
      event_name: rename(n),
      display_name: food ? d.display.replace("Store", "Restaurant") : d.display,
      description: food ? d.description.replace("Store / restaurant", "Restaurant") : d.description,
      category: d.category,
      trigger: d.trigger,
      source: d.source,
      priority: n === revenueEvent || n === activation ? "critical" : d.priority,
      required,
      activation_relevance: n === activation || d.category === "account" || d.category === "onboarding",
      conversion_relevance: !!d.conversion || n === activation,
      revenue_relevance: isRevenue,
      attribution_relevance: !!d.attribution || n === revenueEvent,
      automation_relevance: !!d.automation,
      platforms: platformsFor(d.source),
      reason: [...reasons.get(n)!, d.reason].join(" "),
      source_note: d.sourceNote ?? null,
      properties: props,
    };
  });
  for (const ce of customEvents.values()) events.push({ ...ce, platforms: platformsFor(ce.source) });
  for (const e of events) {
    if (e.event_name === rename(activation)) e.activation_relevance = true;
  }
  events.sort((x, y) => CATEGORY_ORDER.indexOf(x.category) - CATEGORY_ORDER.indexOf(y.category));

  // 10. User properties.
  const upNames: string[] = [...BASE_USER_PROPERTIES, ...model.userProperties];
  for (const m of c.secondary) upNames.push(...MODELS[m].userProperties);
  if (features.has("subscriptions") || streams.includes("subscriptions")) upNames.push("plan", "subscription_status");
  if (features.has("referrals")) upNames.push("referral_code");
  if (features.has("rewards")) upNames.push("reward_points_balance");
  if (["delivery", "booking", "healthcare"].includes(c.primary)) upNames.push("city");
  const userProperties: PlannedUserProperty[] = [...new Set(upNames)].filter((n) => USER_PROPERTY_LIBRARY[n]).map((n) => ({ ...USER_PROPERTY_LIBRARY[n] }));
  if (answers["app.multiple_user_types"] === true) {
    const types = typeof answers["app.user_types"] === "string" ? (answers["app.user_types"] as string).split(/[,،\n]/).map((s) => s.trim()).filter(Boolean) : [];
    if (!userProperties.some((u) => u.name === "user_type")) {
      userProperties.push({
        ...USER_PROPERTY_LIBRARY.user_type,
        description: types.length ? `One of: ${types.join(", ")}.` : USER_PROPERTY_LIBRARY.user_type.description,
        reason: "You have several user types; every funnel and audience can be split by it.",
      });
    }
  }

  // 11. Attribution rules.
  const channels = new Set(arr(answers["attribution.channels"]).filter((c): c is AttributionChannel => c in CHANNEL_RULES));
  if (features.has("deep_links")) channels.add("deep_links");
  if (features.has("referrals")) channels.add("referral");
  const mmp = typeof answers["attribution.existing_mmp"] === "string" && answers["attribution.existing_mmp"] !== "none" ? (answers["attribution.existing_mmp"] as string) : null;
  const attributionRules: PlannedAttributionRule[] = [...channels].map((ch) => ({
    channel: ch,
    parameters: CHANNEL_RULES[ch].parameters,
    click_id_param: CHANNEL_RULES[ch].clickIdParam,
    notes: CHANNEL_RULES[ch].notes + (mmp && answers["attribution.authoritative"] === "mmp" ? ` Attribution for this channel comes from ${mmp} (authoritative); connect its postbacks.` : ""),
  }));
  if (channels.has("deep_links") || channels.size > 0) {
    if (!events.some((e) => e.event_name === "deep_link_opened") && (channels.has("deep_links") || channels.has("influencers") || channels.has("qr"))) {
      const d = EVENT_LIBRARY.deep_link_opened;
      events.splice(events.findIndex((e) => e.category !== "lifecycle"), 0, {
        ...toPlanned(d, platformsFor(d.source)),
        reason: `Your links (${[...channels].filter((x) => ["deep_links", "influencers", "qr"].includes(x)).join(", ")}) open the app. ${d.reason}`,
      });
    }
  }

  // 12. Warnings.
  if (answers["monetization.payment_confirmation"] === "client_only") {
    warnings.push("Payments are only confirmed in the app. Revenue events are recommended from the backend; until you have a server confirmation, revenue numbers can include failed or fraudulent payments.");
  }
  if (answers["monetization.payment_confirmation"] === "store") {
    warnings.push("Store billing: confirm purchases and renewals with App Store Server Notifications and Google Play Real-time Developer Notifications, then send the events from your backend.");
  }
  if (arr(answers["business.currencies"]).length > 1) warnings.push("You take several currencies: always send `currency` with amounts so revenue can be converted to your default currency.");
  if (!channels.size) warnings.push("No acquisition channels selected, so no attribution rules were generated.");
  if (!monetized) warnings.push("Not monetised yet: no revenue event is required. Add one when you start charging.");
  if (mmp) warnings.push(`You use ${mmp}. Keep it: its attribution can flow into this platform (adapter not built yet, see the attribution roadmap).`);

  return {
    generator: GENERATOR_ID,
    business_model: c.primary,
    secondary_models: c.secondary,
    classification: { confidence: c.confidence, signals: c.signals },
    activation_event: rename(activation),
    north_star_event: rename(northStar),
    revenue_event: revenueEvent ? rename(revenueEvent) : null,
    events,
    user_properties: userProperties,
    attribution_rules: attributionRules,
    journey_matches: journeyMatches,
    warnings,
  };
}

function isPrimaryRevenue(d: EventDefinition | undefined): boolean {
  // Refunds and cancellations affect revenue but are never *the* revenue event.
  return !!d?.revenue && !!d.conversion;
}

function toPlanned(d: EventDefinition, platforms: string[]): PlannedEvent {
  return {
    event_name: d.name, display_name: d.display, description: d.description, category: d.category, trigger: d.trigger,
    source: d.source, priority: d.priority, required: d.priority === "critical" || d.priority === "high",
    activation_relevance: false, conversion_relevance: !!d.conversion, revenue_relevance: !!d.revenue,
    attribution_relevance: !!d.attribution, automation_relevance: !!d.automation, platforms, reason: d.reason,
    source_note: d.sourceNote ?? null, properties: d.properties ? PROPERTY_SETS[d.properties] : [],
  };
}

function customEvent(name: string, role: "activation" | "north star"): PlannedEvent {
  const display = name.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return {
    event_name: name, display_name: display, description: `Custom ${role} event you defined.`, category: "custom",
    trigger: "Define when this fires with your team.", source: "mobile_sdk", priority: "critical", required: true,
    activation_relevance: role === "activation", conversion_relevance: true, revenue_relevance: false,
    attribution_relevance: true, automation_relevance: true, platforms: [],
    reason: `You named ${name} as your ${role} event. Add its properties before approving.`, source_note: null, properties: [],
  };
}
