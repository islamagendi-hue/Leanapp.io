import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMonitoring } from "@/lib/monitoring";
import { onRequestError } from "./instrumentation";

describe("onRequestError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetMonitoring();
  });

  it("reports the route template and scrubbed error, never the concrete path, headers or cookies", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/x");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn(async (..._args: unknown[]) => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const err = Object.assign(new Error("failed for jane@example.com"), { digest: "998877" });
    await onRequestError(
      err,
      { path: "/reset-password/SeCrEtToKeN123456789012345?email=jane@example.com", method: "GET", headers: { cookie: "la_session=abc", authorization: "Bearer zzz" } },
      { routerKind: "App Router", routePath: "/reset-password/[token]", routeType: "render", renderSource: "server-rendering", revalidateReason: undefined },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = String((fetch.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("GET /reset-password/[token]");
    expect(body).toContain("source: request:render");
    expect(body).toContain("digest: 998877");
    for (const leaked of ["SeCrEtToKeN", "jane@example.com", "la_session", "abc", "zzz"]) expect(body, leaked).not.toContain(leaked);
  });
});
