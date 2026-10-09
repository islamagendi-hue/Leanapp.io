import { isMediaChannel, validateMediaForChannel, type ChannelCapability, type MediaIssue, type WhatsAppHeader } from "@/modules/media/channel-rules";
import { messagingProvider, providerMediaSupport } from "@/modules/messaging/providers/registry";
import { listMedia } from "@/modules/media/service";
import { apiError } from "@/server/api";
import { mediaJson, mediaRoute, type MediaAssetJson } from "@/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?channel=push&q=…: the library for the MediaPicker, each file with the
 * channel check (errors make it unselectable, warnings are shown). media.read.
 * For WhatsApp and SMS, `provider` narrows the check to that provider's
 * declared media and `header` to the WhatsApp template's header type.
 */
export async function GET(req: Request, route: RouteContext<"/o/[org]/apps/[app]/engage/media/picker">) {
  try {
    const { org, app } = await route.params;
    const { ctx, appId } = await mediaRoute(req, org, app);
    const sp = new URL(req.url).searchParams;
    const channel = sp.get("channel");
    const provider = sp.get("provider");
    const header = sp.get("header")?.toUpperCase();
    const messaging = (channel === "sms" || channel === "whatsapp") && provider && messagingProvider(provider) ? provider : null;
    const cap: ChannelCapability | null = isMediaChannel(channel)
      ? {
        channel,
        ...(messaging ? { provider: messaging, providerMedia: providerMediaSupport(messaging, channel as "sms" | "whatsapp") } : {}),
        ...(channel === "whatsapp" && header && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header) ? { whatsappHeader: header as WhatsAppHeader } : {}),
      }
      : null;
    const { assets } = await listMedia(ctx, appId, { q: sp.get("q") ?? undefined, limit: 120 });
    const items: (MediaAssetJson & { errors: MediaIssue[]; warnings: MediaIssue[] })[] = assets.map((a) => {
      const check = cap ? validateMediaForChannel({ mime: a.mime, kind: a.kind, sizeBytes: a.sizeBytes, width: a.width, height: a.height, animated: a.animated }, cap) : null;
      return { ...mediaJson(org, app, a), errors: check?.errors ?? [], warnings: check?.warnings ?? [] };
    });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError(err);
  }
}
