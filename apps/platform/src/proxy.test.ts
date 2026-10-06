import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, proxy } from "./proxy";

describe("proxy", () => {
  it("sets a nonce CSP on pages and a request id everywhere", () => {
    const page = proxy(new NextRequest("https://app.leanapp.io/login"));
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(page.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const api = proxy(new NextRequest("https://api.leanapp.io/v1/events", { headers: { "x-request-id": "client-req-0001" } }));
    expect(api.headers.get("content-security-policy")).toBeNull();
    expect(api.headers.get("x-request-id")).toBe("client-req-0001");

    // Link redirects (and the in-app browser page with its own nonce CSP) and well-known JSON files get no page CSP.
    expect(proxy(new NextRequest("https://api.leanapp.io/l/shop/AbCdEfGh")).headers.get("content-security-policy")).toBeNull();
    expect(proxy(new NextRequest("https://api.leanapp.io/.well-known/apple-app-site-association")).headers.get("content-security-policy")).toBeNull();

    const bad = proxy(new NextRequest("https://api.leanapp.io/v1/events", { headers: { "x-request-id": "<script>" } }));
    expect(bad.headers.get("x-request-id")).not.toBe("<script>");
  });

  it("only upgrades insecure requests over https and allows eval only in development", () => {
    expect(contentSecurityPolicy("n", { dev: false, https: false })).not.toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("n", { dev: false, https: true })).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("n", { dev: true, https: false })).toContain("'unsafe-eval'");
  });
});
