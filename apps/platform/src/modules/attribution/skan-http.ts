import "server-only";
import { log } from "@/lib/log";
import { handleSkanPostback } from "./skan-service";

/** Shared HTTP wrapper for the two well-known postback routes. */
export async function skanResponse(req: Request, framework: "skadnetwork" | "adattributionkit"): Promise<Response> {
  try {
    const out = await handleSkanPostback(framework, await req.text(), req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null);
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (out.retryAfter) headers["Retry-After"] = String(out.retryAfter);
    return Response.json(out.body, { status: out.status, headers });
  } catch (err) {
    log.error("attribution.skan_route_failed", { error: err });
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
