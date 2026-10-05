import { UnauthorizedError } from "@/lib/errors";
import { getUserBySessionToken } from "@/modules/auth/service";
import { listOrganizationsForUser } from "@/modules/organizations/service";
import { apiError } from "@/server/api";
import { SESSION_COOKIE } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const token = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    const user = await getUserBySessionToken(token ? decodeURIComponent(token) : null);
    if (!user) throw new UnauthorizedError();
    return Response.json({ organizations: await listOrganizationsForUser(user.id) });
  } catch (err) {
    return apiError(err);
  }
}
