import { AR } from "@/i18n/ar";
import { makeT, pickLang, type Lang } from "@/i18n/translate";
import { applyUnsubscribe, unsubscribeTokenValid } from "@/modules/messaging/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Unsubscribe link in automation emails (docs/messaging.md).
 * GET shows a confirmation button (link scanners must not unsubscribe people);
 * POST unsubscribes: both that button and RFC 8058 one-click requests from
 * mail providers ("List-Unsubscribe=One-Click"). Adds an `email` suppression.
 * Text is in the reader's language (read from the request itself, so the
 * handler also works when called directly); `title` and `body` are already escaped HTML.
 */
function langOf(req: Request): Lang {
  const cookie = req.headers.get("cookie")?.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
  return pickLang(cookie, req.headers.get("accept-language"));
}
const tFor = (lang: Lang) => makeT(lang === "ar" ? AR : null);

const page = (lang: Lang, title: string, body: string, status = 200) => {
  return new Response(
    `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin-inline:auto;padding:3rem 1rem;line-height:1.5;color:#1d1d1f;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1d1d1f;background:#1d1d1f;color:#fff;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111;border-color:#eee}}</style></head>
<body><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
};

const notFound = (lang: Lang) => {
  const t = tFor(lang);
  return page(lang, esc(t("Link not valid")), `<p>${esc(t("This unsubscribe link is not valid or has expired."))}</p>`, 404);
};

export async function GET(req: Request, ctx: RouteContext<"/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  const lang = langOf(req);
  if (!(await unsubscribeTokenValid(token))) return notFound(lang);
  const t = tFor(lang);
  return page(lang, 
    esc(t("Unsubscribe from these emails?")),
    `<p>${esc(t("You won't receive these emails any more."))}</p><form method="post"><button type="submit">${esc(t("Unsubscribe"))}</button></form>`,
  );
}

export async function POST(req: Request, ctx: RouteContext<"/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  const lang = langOf(req);
  if (!(await applyUnsubscribe(token))) return notFound(lang);
  const t = tFor(lang);
  return page(lang, esc(t("You're unsubscribed")), `<p>${esc(t("You won't receive these emails any more."))}</p>`);
}
