import { withSystem } from "@/lib/db";
import { log } from "@/lib/log";
import { getUserBySessionToken } from "@/modules/auth/service";
import { codeFrom, OAUTH_COOKIE, redirectUri } from "@/modules/integrations/oauth";
import { isAdProvider } from "@/modules/integrations/registry";
import { completeOAuth, consumeOAuthState, OAuthStateError } from "@/modules/integrations/service";
import { resolveTenant } from "@/modules/tenancy/context";
import { publicAppUrl } from "@/server/env";
import { SESSION_COOKIE } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieOf = (req: Request, name: string) => {
  const raw = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  return raw ? decodeURIComponent(raw) : null;
};

const clearState = `${OAUTH_COOKIE}=; Path=/integrations/oauth; Max-Age=0; HttpOnly; SameSite=Lax`;

function back(path: string, outcome: string) {
  return new Response(null, { status: 303, headers: { Location: `${publicAppUrl()}${path}?oauth=${outcome}`, "Set-Cookie": clearState, "Cache-Control": "no-store" } });
}

/**
 * Return leg of "Connect with …" (Meta, Google Ads, TikTok, Snapchat). The
 * state must match the httpOnly cookie set when the flow started and an
 * unused, unexpired row bound to the signed-in user (modules/integrations/service).
 * The code is exchanged server-side; tokens never reach the browser.
 */
export async function GET(req: Request, ctx: RouteContext<"/integrations/oauth/[provider]/callback">) {
  const { provider } = await ctx.params;
  if (!isAdProvider(provider)) return new Response("Unknown provider", { status: 404 });
  const params = new URL(req.url).searchParams;
  const user = await getUserBySessionToken(cookieOf(req, SESSION_COOKIE));
  if (!user) return new Response("Sign in to LeanApp first, then connect again.", { status: 401, headers: { "Set-Cookie": clearState } });
  let s;
  try {
    s = await consumeOAuthState(user.id, provider, params.get("state"), cookieOf(req, OAUTH_COOKIE));
  } catch (err) {
    if (err instanceof OAuthStateError) return new Response("This connection link is invalid or expired. Start again from the Integrations page.", { status: 400, headers: { "Set-Cookie": clearState } });
    throw err;
  }
  if (params.get("error")) return back(s.return_path, "denied");
  const code = codeFrom(provider, params);
  if (!code) return back(s.return_path, "error");
  try {
    const org = await withSystem((db) => db.one<{ slug: string }>("select slug from platform.organizations where id = $1", [s.organization_id]));
    const tenant = await resolveTenant(user.id, org?.slug ?? "");
    await completeOAuth(tenant, s, provider, code, redirectUri(publicAppUrl(), provider));
    return back(s.return_path, "connected");
  } catch (err) {
    log.warn("integrations.oauth_failed", { provider, error_name: (err as Error).name });
    return back(s.return_path, "error");
  }
}
