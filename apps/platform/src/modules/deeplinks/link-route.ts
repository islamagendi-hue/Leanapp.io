import "server-only";
import { log } from "@/lib/log";
import { handleClick } from "@/modules/attribution/service";
import { inAppBrowser } from "./pure";
import { interstitialFor, prefixMatches } from "./service";

const HEADERS = { "Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

/**
 * GET /l/{code} and /l/{prefix}/{code}: records the click (modules/attribution handleClick)
 * and redirects to the App Store, Play Store (click id in `referrer`) or web fallback.
 * Inside Instagram / Facebook / TikTok / Snapchat in-app browsers, which keep Universal
 * Links and App Links from opening the app, it serves the "Open in app" page instead.
 * When the app is installed, iOS / Android open /l/{prefix}/{code} in the app directly
 * and this route is never reached; the SDK resolves the link (/v1/deep-links/resolve).
 */
export async function handleLinkRequest(req: Request, code: string, prefix: string | null): Promise<Response> {
  const url = new URL(req.url);
  const notFound = () => new Response("Link not found.", { status: 404, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
  try {
    if (prefix !== null && !(await prefixMatches(prefix, code))) return notFound();
    const out = await handleClick(code, {
      method: req.method,
      headers: req.headers,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null,
      query: url.searchParams,
    });
    if (out.status === 404) return notFound();
    const ua = req.headers.get("user-agent");
    if (req.method === "GET" && inAppBrowser(ua)) {
      const page = await interstitialFor(code, {
        userAgent: ua,
        acceptLanguage: req.headers.get("accept-language"),
        location: out.location,
        clickId: out.recorded ? out.clickId : null,
      });
      if (page) {
        return new Response(page.html, {
          status: 200,
          headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.csp, "X-Frame-Options": "DENY" },
        });
      }
    }
    return new Response(null, { status: 302, headers: { ...HEADERS, Location: out.location } });
  } catch (err) {
    log.error("attribution.click_failed", { error: err });
    return new Response("Something went wrong. Please try the link again.", { status: 503, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" } });
  }
}
