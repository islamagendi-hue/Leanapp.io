import { describe, expect, it } from "vitest";
import { deepLinkCapabilities } from "./capabilities";

const base = { ios_team_id: "ABCDE12345", ios_bundle_ids: ["com.example.app"], android_package: "com.example.app", android_sha256: ["AA"], deferred_enabled: true, last_check: null };
const status = (c: ReturnType<typeof deepLinkCapabilities>) => Object.fromEntries(c.map((x) => [x.key, x.status]));

describe("deepLinkCapabilities", () => {
  it("without setup only the fallback and campaign capture work", () => {
    expect(status(deepLinkCapabilities(null))).toEqual({ fallback: "live", ios: "needs_setup", android: "needs_setup", campaign: "live", deferred: "needs_setup" });
  });

  it("an association is live only after a passing check", () => {
    expect(status(deepLinkCapabilities(base)).ios).toBe("unverified");
    const checked = deepLinkCapabilities({ ...base, last_check: [{ file: "apple-app-site-association", ok: true }, { file: "assetlinks.json", ok: false }, { file: "apple-cdn", ok: false, warning: true }] });
    expect(status(checked)).toMatchObject({ ios: "live", android: "unverified" });
    // The resolve endpoint is a GET (src/app/v1/deep-links/resolve/route.ts exports GET only).
    const ios = checked.find((c) => c.key === "ios")!;
    expect(ios.detail).toContain("GET /v1/deep-links/resolve");
    expect(ios.detail).not.toContain("POST /v1/deep-links/resolve");
  });

  it("deferred deep links are never claimed as live", () => {
    const on = deepLinkCapabilities(base).find((c) => c.key === "deferred")!;
    expect(on.status).toBe("beta");
    expect(on.detail).toMatch(/once on a new install's first open/);
    expect(status(deepLinkCapabilities({ ...base, deferred_enabled: false })).deferred).toBe("off");
  });
});
