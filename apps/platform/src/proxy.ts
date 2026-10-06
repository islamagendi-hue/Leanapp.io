import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every request:
 * - gives each request an id (`x-request-id`, kept from the caller when it is
 *   well-formed) that logs and API errors carry, and echoes it in the response;
 * - sets a nonce-based Content-Security-Policy on pages. Next.js applies the
 *   nonce to its own scripts; API responses are JSON and don't need one.
 */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function contentSecurityPolicy(nonce: string, opts: { dev: boolean; https: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // React renders style attributes (e.g. progress bars); nonces can't cover attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(opts.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  const path = request.nextUrl.pathname;
  // next.config sets skipTrailingSlashRedirect so Apple's postback URLs (/.well-known/…/report-attribution/)
  // are served as sent; every other path keeps Next's default (drop the trailing slash, 308).
  if (path.length > 1 && path.endsWith("/") && !path.startsWith("/.well-known/")) {
    // A plain URL: NextURL keeps the trailing slash it was parsed with.
    const url = new URL(request.url);
    url.pathname = path.replace(/\/+$/, "") || "/";
    return NextResponse.redirect(url, 308);
  }
  // Link redirects set their own headers (the in-app browser page carries its own nonce CSP); well-known files are JSON.
  const isPage = !path.startsWith("/v1/") && !path.startsWith("/api/") && !path.startsWith("/l/") && !path.startsWith("/.well-known/") && !path.endsWith("/export");
  let csp: string | null = null;
  if (isPage) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const https = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
    csp = contentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development", https });
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);
  if (csp) response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|.*\\.(?:png|svg|jpg|ico|woff2|txt)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
