import "server-only";
import { ValidationError } from "@/lib/errors";
import { audit } from "@/modules/audit/service";
import { tenantTx, type TenantContext } from "@/modules/tenancy/context";
import { loadDeliveryCredentials, markIntegration, mergeIntegrationConfig } from "./integrations";
import { adapterFor } from "./providers/adapters";

/**
 * "Check connection" for messaging providers: one read-only call to the
 * provider's real API with the stored credentials (Meta: the phone number;
 * Twilio: the account). The result is exactly what the provider answered.
 * It does not mark the integration as verified live: only a successful real
 * send does that (integrations.live_verified_at).
 */
export async function verifyConnection(ctx: TenantContext, environmentId: string, provider: "whatsapp" | "twilio"): Promise<{ ok: boolean; detail: string }> {
  const adapter = adapterFor(provider === "whatsapp" ? "whatsapp_cloud" : "twilio")!;
  const creds = await tenantTx(ctx, "integrations.manage", (db) => loadDeliveryCredentials(db, environmentId));
  if (creds.errors[provider]) throw new ValidationError("The stored credentials can't be read (the server's encryption key changed). Reconnect the provider.");
  const r = await adapter.verify(creds);
  if (!r) throw new ValidationError(provider === "whatsapp" ? "WhatsApp isn't connected in this environment." : "Twilio isn't connected in this environment.");
  const integrationId = provider === "whatsapp" ? creds.whatsapp!.id : creds.twilio!.id;
  await tenantTx(ctx, "integrations.manage", async (db) => {
    await markIntegration(db, integrationId, r.ok ? null : `Connection check: ${r.detail}`);
    await mergeIntegrationConfig(db, integrationId, { ...(r.ok ? r.config ?? {} : {}), connection_checked_at: new Date().toISOString(), connection_check: r.ok ? "ok" : "failed" });
    await audit(db, { organizationId: ctx.organizationId, actorUserId: ctx.userId, action: "integration.verified", targetType: "integration", targetId: integrationId, metadata: { environment_id: environmentId, provider, ok: r.ok, live: r.live } });
  });
  return { ok: r.ok, detail: r.live ? r.detail : `${r.detail} (local mock, not the live API)` };
}
