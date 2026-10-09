"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { log } from "@/lib/log";
import { demoEnabled, demoSession, ensureDemo } from "@/modules/marketing/demo";
import { setSessionCookie } from "@/server/session";

/** Signs the visitor in to the public demo as a read-only Viewer and opens its Overview. */
export async function startDemoAction(): Promise<void> {
  if (!demoEnabled()) redirect("/signup");
  let target: string;
  try {
    // Only sends events when the demo has none yet; the scheduled worker keeps it current.
    const refs = await ensureDemo({ staleHours: Number.POSITIVE_INFINITY, deadline: Date.now() + 40_000 });
    const s = await demoSession(refs, (await headers()).get("user-agent"));
    await setSessionCookie(s.token, s.expiresAt);
    target = `/o/${refs.orgSlug}/apps/${refs.appSlug}?env=production`;
  } catch (e) {
    log.error("demo.start_failed", { error: e });
    redirect("/demo?error=1");
  }
  redirect(target);
}
