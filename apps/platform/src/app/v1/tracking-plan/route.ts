import { NotFoundError } from "@/lib/errors";
import { planToJson } from "@/modules/implementation/diff";
import { readPlan } from "@/modules/implementation/editor";
import { getKeyApp } from "@/modules/management/service";
import { managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /v1/tracking-plan (secret key, management:read): the app's published tracking plan as JSON. */
export function GET(req: Request) {
  return managementApi(req, "/v1/tracking-plan", "management:read", async (key) => {
    const plan = await readPlan({ kind: "api_key", organizationId: key.organizationId, appId: key.appId, keyId: key.keyId }, key.appId, "published");
    if (!plan) throw new NotFoundError("Published tracking plan");
    const app = await getKeyApp(key);
    return planToJson(plan, app);
  });
}
