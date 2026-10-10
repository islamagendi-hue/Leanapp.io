import { assignmentsFor } from "@/modules/experiments/assignment";
import { experimentEndpoint, preflight } from "@/modules/experiments/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

/**
 * GET /v1/experiments/assignments?user_id=…&anonymous_id=… with the app's public SDK key:
 * the variant of every running experiment in the key's environment for that person (docs/sdk.md#experiments).
 */
export function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  return experimentEndpoint(req, "/v1/experiments/assignments", (key) =>
    assignmentsFor(key, { user_id: q.get("user_id") ?? undefined, anonymous_id: q.get("anonymous_id") ?? undefined }),
  );
}

/** POST /v1/experiments/assignments with `{ user_id?, anonymous_id? }`: the same answer as GET, for ids you'd rather not put in a URL. */
export function POST(req: Request) {
  return experimentEndpoint(req, "/v1/experiments/assignments", async (key) => {
    const body: unknown = await req.json().catch(() => null);
    return assignmentsFor(key, body && typeof body === "object" ? body : {});
  });
}
