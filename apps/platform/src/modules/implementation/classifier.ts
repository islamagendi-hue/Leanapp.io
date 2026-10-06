/**
 * Business model classification from questionnaire answers.
 *
 * Deterministic and explainable: an explicit model answer wins; otherwise
 * keyword evidence from the free-text answers is scored. Secondary models
 * (e.g. a delivery app that also sells subscriptions) come from evidence and
 * monetization answers. Every decision returns its signals so the plan can
 * show *why*.
 */
import { BUSINESS_MODELS, MODELS, type BusinessModel } from "./catalog/models";
import type { Answers } from "./questions";

export interface Classification {
  primary: BusinessModel;
  secondary: BusinessModel[];
  confidence: "high" | "medium" | "low";
  signals: string[];
  /** True when food words are present (restaurant naming instead of store). */
  food: boolean;
}

const FREE_TEXT_KEYS = ["business.description", "business.problem", "business.value", "app.primary_action", "app.first_action", "journey.description"];
/** A primary model that already covers another model's behaviour (a delivery app has a cart). */
const SUBSUMES: Partial<Record<BusinessModel, BusinessModel[]>> = {
  delivery: ["ecommerce"],
  marketplace: ["ecommerce"],
  saas: ["subscription"],
  healthcare: ["booking"],
  booking: ["healthcare"],
};

const FOOD = /\b(food|restaurants?|meals?|dishes|cuisine|burgers?|pizza|shawarma|coffee|مطعم|مطاعم|طعام|وجبات)\b/i;

export function freeText(a: Answers): string {
  return FREE_TEXT_KEYS.map((k) => (typeof a[k] === "string" ? (a[k] as string) : "")).join(" \n ");
}

export function scoreModels(text: string): { model: BusinessModel; score: number; hits: string[] }[] {
  const lower = text.toLowerCase();
  return BUSINESS_MODELS.filter((m) => m !== "other")
    .map((m) => {
      const hits = MODELS[m].keywords.filter((k) => {
        const re = new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");
        return re.test(lower);
      });
      return { model: m, score: hits.length, hits };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
}

export function classifyBusiness(a: Answers): Classification {
  const text = freeText(a);
  const scored = scoreModels(text);
  const signals: string[] = [];
  const explicit = typeof a["business.model"] === "string" && (BUSINESS_MODELS as readonly string[]).includes(a["business.model"] as string)
    ? (a["business.model"] as BusinessModel)
    : null;

  let primary: BusinessModel;
  let confidence: Classification["confidence"];
  if (explicit) {
    primary = explicit;
    confidence = "high";
    signals.push(`You chose ${explicit}.`);
  } else if (scored[0]) {
    primary = scored[0].model;
    confidence = scored[0].score >= 2 && (!scored[1] || scored[0].score > scored[1].score) ? "medium" : "low";
    signals.push(`Your description mentions ${scored[0].hits.map((h) => `“${h}”`).join(", ")}.`);
  } else {
    primary = "other";
    confidence = "low";
    signals.push("No clear business-model keywords yet.");
  }

  const secondary = new Set<BusinessModel>();
  for (const s of scored) if (s.model !== primary && s.score >= 2 && !SUBSUMES[primary]?.includes(s.model)) secondary.add(s.model);
  const streams = Array.isArray(a["monetization.streams"]) ? (a["monetization.streams"] as string[]) : [];
  if (streams.includes("subscriptions") && primary !== "subscription" && primary !== "saas") {
    secondary.add("subscription");
    signals.push("You charge subscriptions, so subscription events are included.");
  }
  if (streams.includes("ads") && primary !== "advertising") {
    secondary.add("advertising");
    signals.push("You earn from ads, so ad revenue is tracked.");
  }
  for (const m of secondary) if (scored.find((s) => s.model === m)) signals.push(`Also looks like ${m} (${scored.find((s) => s.model === m)!.hits.join(", ")}).`);

  return { primary, secondary: [...secondary], confidence, signals, food: FOOD.test(text) };
}
