/**
 * Shows English text the implementation engine wrote (stored plan reasons,
 * classifier signals, score details, validation and editor messages) in the
 * reader's language. The stored text stays English; this looks it up sentence
 * by sentence in the dictionary (catalog texts are marked with msg() where
 * they are defined) and fills the sentences built with names through the
 * patterns below. Anything unknown (a customer's own text) is left as is.
 * Pure and client-safe.
 */
import { msg, type Lang, type T } from "@/i18n/translate";
import { FEATURE_LABELS, FEATURES, MODEL_LABELS, type BusinessModel } from "./catalog/models";

type Mapper = (value: string, t: T) => string;
interface Rule {
  re: RegExp;
  key: string;
  /** Named groups to translate before filling (e.g. a model label). */
  map?: Record<string, Mapper>;
}

const tr: Mapper = (v, t) => t(v);
const model: Mapper = (v, t) => t(MODEL_LABELS[v as BusinessModel] ?? v);
const feature: Mapper = (v, t) => {
  const f = FEATURES.find((x) => x.replace(/_/g, " ") === v);
  return f ? t(FEATURE_LABELS[f]) : v;
};

const RULES: Rule[] = [
  // Generator reasons and notes
  { re: /^Core (?<model>[^.]+) event\.$/, key: msg("Core {model} event."), map: { model: tr } },
  { re: /^Your app also has (?<model>[^.]+) behaviour\.$/, key: msg("Your app also has {model} behaviour."), map: { model: tr } },
  { re: /^Your app has (?<feature>[a-z ]+)\.$/, key: msg("Your app has {feature}."), map: { feature } },
  { re: /^Mentioned in your journey: “(?<phrase>[^”]*)”\.$/, key: msg("Mentioned in your journey: “{phrase}”.") },
  { re: /^Your links \((?<channels>[^)]*)\) open the app\.$/, key: msg("Your links ({channels}) open the app.") },
  { re: /^You named (?<name>\S+) as your activation event\. Add its properties before approving\.$/, key: msg("You named {name} as your activation event. Add its properties before approving.") },
  { re: /^You named (?<name>\S+) as your north star event\. Add its properties before approving\.$/, key: msg("You named {name} as your north star event. Add its properties before approving.") },
  { re: /^One of: (?<types>[^.]*)\.$/, key: msg("One of: {types}.") },
  { re: /^Attribution for this channel comes from (?<mmp>\S+) \(authoritative\); connect its postbacks\.$/, key: msg("Attribution for this channel comes from {mmp} (authoritative); connect its postbacks.") },
  { re: /^You use (?<mmp>\S+)\. Keep it: its attribution can flow into this platform \(adapter not built yet, see the attribution roadmap\)\.$/, key: msg("You use {mmp}. Keep it: its attribution can flow into this platform (adapter not built yet, see the attribution roadmap).") },
  // Classifier signals
  { re: /^You chose (?<model>\w+)\.$/, key: msg("You chose {model}."), map: { model } },
  { re: /^Your description mentions (?<hits>[^.]*)\.$/, key: msg("Your description mentions {hits}.") },
  { re: /^Also looks like (?<model>\w+) \((?<hits>[^)]*)\)\.$/, key: msg("Also looks like {model} ({hits})."), map: { model } },
  // SDK notes
  { re: /^Not published to (?<registry>[^.]+) yet\. Add it from the LeanApp repository \((?<path>[^)]+)\); see its README\.$/, key: msg("Not published to {registry} yet. Add it from the LeanApp repository ({path}); see its README.") },
  // Implementation score details
  { re: /^(?<a>\d+)\/(?<b>\d+) required app events valid\.$/, key: msg("{a}/{b} required app events valid.") },
  { re: /^(?<a>\d+)\/(?<b>\d+) revenue events valid\.$/, key: msg("{a}/{b} revenue events valid.") },
  { re: /^(?<a>\d+)\/(?<b>\d+) planned user properties seen\.$/, key: msg("{a}/{b} planned user properties seen.") },
  { re: /^(?<a>\d+)\/(?<b>\d+) attribution parameters seen\.$/, key: msg("{a}/{b} attribution parameters seen.") },
  { re: /^(?<a>\d+)\/(?<b>\d+) backend events received from a server\.$/, key: msg("{a}/{b} backend events received from a server.") },
  { re: /^(?<a>\d+)\/(?<b>\d+) automation trigger events valid\.$/, key: msg("{a}/{b} automation trigger events valid.") },
  // Event validation (validate.ts)
  { re: /^(?<name>\S+) is required$/, key: msg("{name} is required") },
  { re: /^(?<name>\S+) should be (?<type>\w+)$/, key: msg("{name} should be {type}") },
  { re: /^(?<name>\S+) must be an ISO 4217 code like SAR or AED$/, key: msg("{name} must be an ISO 4217 code like SAR or AED") },
  { re: /^(?<name>\S+) is not one of the planned values$/, key: msg("{name} is not one of the planned values") },
  { re: /^(?<name>\S+) must not be negative \(send refunds as refund events\)$/, key: msg("{name} must not be negative (send refunds as refund events)") },
  { re: /^(?<name>\S+) is not in the tracking plan$/, key: msg("{name} is not in the tracking plan") },
  { re: /^(?<name>\S+) describes an action, not the user\. Send it as an event property instead\.$/, key: msg("{name} describes an action, not the user. Send it as an event property instead.") },
  // Plan editing (plan-input.ts, editor.ts, service.ts)
  { re: /^(?<name>\S+) is sent by the SDK for identify \/ alias \/ push-token calls and can't be planned as a custom event\.$/, key: msg("{name} is sent by the SDK for identify / alias / push-token calls and can't be planned as a custom event.") },
  { re: /^Looks like the standard event (?<name>\S+)\. Use the standard name if it means the same thing\.$/, key: msg("Looks like the standard event {name}. Use the standard name if it means the same thing.") },
  { re: /^(?<name>\S+) is a top-level event field, not a property\.$/, key: msg("{name} is a top-level event field, not a property.") },
  { re: /^(?<name>\S+) describes an action, not the person\. Make it an event property instead\.$/, key: msg("{name} describes an action, not the person. Make it an event property instead.") },
  { re: /^Property (?<name>\S+) is listed twice\.$/, key: msg("Property {name} is listed twice.") },
  { re: /^Allowed values only apply to string properties \((?<name>\S+) is (?<type>\w+)\)\.$/, key: msg("Allowed values only apply to string properties ({name} is {type}).") },
  { re: /^(?<name>\S+) is already in the plan\. Edit it instead\.$/, key: msg("{name} is already in the plan. Edit it instead.") },
  { re: /^Event (?<name>\S+) not found\.$/, key: msg("Event {name} not found.") },
  { re: /^Property (?<name>\S+) not found\.$/, key: msg("Property {name} not found.") },
  { re: /^User property (?<name>\S+) not found\.$/, key: msg("User property {name} not found.") },
  { re: /^Version (?<version>\d+) is (?<status>\w+), not a draft\.$/, key: msg("Version {version} is {status}, not a draft."), map: { status: tr } },
];

function one(s: string, t: T): string | null {
  const d = t(s);
  if (d !== s) return d;
  for (const r of RULES) {
    const m = r.re.exec(s);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) params[k] = r.map?.[k] ? r.map[k](v, t) : v;
    return t(r.key, params);
  }
  return null;
}

/** The text in the reader's language, sentence by sentence; unknown sentences stay as written. */
export function localizeText(text: string | null | undefined, t: T, lang: Lang): string {
  if (!text) return text ?? "";
  if (lang === "en") return text;
  const whole = one(text, t);
  if (whole !== null) return whole;
  const parts = text.split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return text;
  const out: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let j = parts.length;
    let hit: string | null = null;
    // Longest run of sentences that is known as a whole (a catalog text can hold several sentences).
    for (; j > i; j--) {
      hit = one(parts.slice(i, j).join(" "), t);
      if (hit !== null) break;
    }
    if (hit !== null) {
      out.push(hit);
      i = j;
    } else {
      out.push(parts[i]);
      i += 1;
    }
  }
  return out.join(" ");
}
