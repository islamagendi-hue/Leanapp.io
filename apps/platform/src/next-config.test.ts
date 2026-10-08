import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

/** The page or route file under app/ that serves a redirect destination like /o/:org/apps/:app/acquisition. */
function served(destination: string): boolean {
  const dir = path.join(import.meta.dirname, "app", destination.replace("/:path*", "").replace(":org", "[org]").replace(":app", "[app]"));
  return existsSync(path.join(dir, "page.tsx")) || existsSync(path.join(dir, "route.ts"));
}

describe("redirects from moved project pages", () => {
  it("send every old address to a page that exists, and never to itself", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.length).toBeGreaterThan(10);
    for (const r of redirects) {
      expect(served(r.destination), r.destination).toBe(true);
      expect(served(r.source), `${r.source} is still a page, so the redirect would hide it`).toBe(false);
      expect(r.permanent).toBe(false);
    }
  });
});
