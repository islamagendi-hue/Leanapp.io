import { addPlanEvent } from "@/modules/implementation/editor";
import { jsonBody, managementApi } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /v1/tracking-plan/events (secret key, plan:write): adds a custom event to the
 * plan's draft (copying the published version into a new draft when there is none).
 * Nothing is published: a person still approves and publishes the draft.
 */
export function POST(req: Request) {
  return managementApi(
    req,
    "/v1/tracking-plan/events",
    "plan:write",
    async (key) => {
      const body = await jsonBody(req, 32_768);
      const r = await addPlanEvent({ kind: "api_key", organizationId: key.organizationId, appId: key.appId, keyId: key.keyId }, key.appId, body);
      return { version_id: r.versionId, version: r.version, status: "draft", draft_created: r.draftCreated, event_name: String(body.event_name).trim(), warnings: r.warnings };
    },
    { status: 201 },
  );
}
