/**
 * Event-name mismatch detection: `purchase` probably means `purchase_completed`.
 * Token similarity with light stemming and synonyms, plus edit distance.
 */
const SYNONYMS: Record<string, string> = {
  buy: "purchase", bought: "purchase", purchased: "purchase", paid: "purchase", pay: "purchase", payment: "purchase", order: "purchase", orders: "purchase", ordered: "purchase", transaction: "purchase",
  register: "signup", registered: "signup", registration: "signup", sign: "signup", signed: "signup",
  signin: "login", logged: "login", log: "login",
  add: "added", adds: "added", addtocart: "added", remove: "removed",
  view: "viewed", views: "viewed", open: "viewed", opened: "viewed", show: "viewed", shown: "viewed", see: "viewed", visit: "viewed",
  complete: "completed", completes: "completed", done: "completed", finish: "completed", finished: "completed", success: "completed", succeeded: "completed",
  start: "started", starts: "started", begin: "started", began: "started", init: "started", initiated: "started",
  item: "product", sku: "product", basket: "cart", bag: "cart", subscribe: "subscription", subscribed: "subscription",
  screen: "screen", page: "screen", installed: "installed", install: "installed",
};

export function tokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/sign[_\s-]?up/g, "signup")
    .replace(/(log|sign)[_\s-]?in/g, "login")
    .replace(/add[_\s-]?to[_\s-]?cart/g, "added_cart")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => SYNONYMS[t] ?? t);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size || 1;
  const jaccard = inter / union;
  // Containment: every received token appears in the planned name (purchase ⊂ purchase_completed).
  const containment = ta.size ? inter / ta.size : 0;
  const na = tokens(a).join("_");
  const nb = tokens(b).join("_");
  const edit = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length, 1);
  // Tie-break toward the completed state when the received name has no state ("purchase" → *_completed, not *_cancelled).
  const STATES = ["completed", "started", "cancelled", "viewed", "added", "removed", "failed", "delivered", "expired", "renewed"];
  const bonus = tb.has("completed") && ![...ta].some((t) => STATES.includes(t)) ? 0.05 : 0;
  return Math.min(1, Math.max(jaccard, edit, containment * 0.85) + bonus);
}

/** Best planned event for an unplanned name, or null when nothing is close enough. */
export function suggestMapping(received: string, planned: string[], threshold = 0.6): { to: string; score: number } | null {
  let best: { to: string; score: number } | null = null;
  for (const p of planned) {
    if (p === received) return null;
    const s = similarity(received, p);
    if (!best || s > best.score) best = { to: p, score: s };
  }
  return best && best.score >= threshold ? { to: best.to, score: Math.round(best.score * 100) / 100 } : null;
}
