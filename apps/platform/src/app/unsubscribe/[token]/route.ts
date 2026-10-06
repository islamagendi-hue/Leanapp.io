import { applyUnsubscribe, unsubscribeTokenValid } from "@/modules/messaging/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Unsubscribe link in automation emails (docs/messaging.md).
 * GET shows a confirmation button (link scanners must not unsubscribe people);
 * POST unsubscribes: both that button and RFC 8058 one-click requests from
 * mail providers ("List-Unsubscribe=One-Click"). Adds an `email` suppression.
 */
const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin-inline:auto;padding:3rem 1rem;line-height:1.5;color:#1d1d1f;background:#fff}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1d1d1f;background:#1d1d1f;color:#fff;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111;border-color:#eee}}</style></head>
<body><h1 style="font-size:1.4rem">${title}</h1>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );

const notFound = () => page("Link not valid", "<p>This unsubscribe link is not valid or has expired.</p>", 404);

export async function GET(_: Request, ctx: RouteContext<"/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  if (!(await unsubscribeTokenValid(token))) return notFound();
  return page(
    "Unsubscribe from these emails?",
    `<p>You won&#39;t receive these emails any more.</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(_: Request, ctx: RouteContext<"/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  if (!(await applyUnsubscribe(token))) return notFound();
  return page("You're unsubscribed", "<p>You won&#39;t receive these emails any more.</p>");
}
