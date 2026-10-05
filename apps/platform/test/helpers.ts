import { signUp } from "@/modules/auth/service";
import { createApp, getAppBySlug } from "@/modules/apps/service";
import { listKeys } from "@/modules/credentials/service";
import { createOrganization } from "@/modules/organizations/service";
import { resolveTenant, type TenantContext } from "@/modules/tenancy/context";

let n = 0;
export async function makeTenant(label = "org") {
  n++;
  const email = `${label}-${n}-${Date.now()}@example.com`;
  const { user } = await signUp({ name: `User ${label}`, email, password: "correct-horse-9" }, { ip: `10.0.${n}.1` });
  const org = await createOrganization(user.id, { name: `${label} Org ${n}`, timezone: "Asia/Riyadh", defaultCurrency: "SAR" });
  const ctx = await resolveTenant(user.id, org.slug);
  const app = await createApp(ctx, { name: `${label} App`, platforms: ["android", "ios"] });
  const { environments } = await getAppBySlug(ctx, app.slug);
  const keys = await listKeys(ctx, app.id);
  const dev = environments.find((e) => e.type === "development")!;
  const sdkKey = keys.sdkKeys.find((k) => k.environment_id === dev.id)!.key;
  return { user, org, ctx: ctx as TenantContext, app, environments, dev, sdkKey };
}
