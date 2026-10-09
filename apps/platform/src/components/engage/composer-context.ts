import "server-only";
import { listIntegrations } from "@/modules/messaging/integrations";
import { can } from "@/modules/rbac/authorize";
import type { TenantContext } from "@/modules/tenancy/context";
import { knownProperties } from "./shared";

/** What the campaign composer needs to know about the environment: connected messaging providers and user attributes for variable mapping. */
export async function composerContext(ctx: TenantContext, appId: string, environmentId: string): Promise<{
  connected: { whatsapp: ("whatsapp_cloud" | "twilio")[]; sms: boolean };
  userProperties: string[];
}> {
  const [rows, props] = await Promise.all([
    can(ctx.role, "integrations.read") ? listIntegrations(ctx, environmentId) : Promise.resolve(null),
    knownProperties(ctx, appId, environmentId),
  ]);
  const twilio = rows?.find((r) => r.provider === "twilio");
  // Without integrations.read the composer can't tell; it offers Meta and lets the server's check say what's connected.
  const whatsapp: ("whatsapp_cloud" | "twilio")[] = rows === null
    ? ["whatsapp_cloud"]
    : [...(rows.some((r) => r.provider === "whatsapp") ? ["whatsapp_cloud" as const] : []), ...(twilio?.config.whatsapp_from ? ["twilio" as const] : [])];
  return {
    connected: { whatsapp, sms: rows === null ? true : Boolean(twilio && (twilio.config.messaging_service_sid || twilio.config.from_number)) },
    userProperties: props.user.map((p) => p.name),
  };
}
