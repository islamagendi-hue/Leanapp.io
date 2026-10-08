import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repo holds several packages, each with its own lockfile; pin the root to this folder.
const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // pg is a Node-only dependency; keep it out of the bundler.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Apple posts SKAdNetwork / AdAttributionKit postbacks to /.well-known/…/report-attribution/ (trailing slash)
  // and devices may not follow a redirect; proxy.ts keeps the default trailing-slash redirect for every other path.
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: root,
  turbopack: { root },
  // Project pages that moved into Settings → Dev Ops, Settings → Project and Acquisition keep their
  // old addresses working (query strings are carried over). Temporary, so they can move again.
  async redirects() {
    const app = "/o/:org/apps/:app";
    const moved: [string, string][] = [
      ["/implementation/questions", "/settings/dev-ops/implementation/questions"],
      ["/implementation/plan/:path*", "/settings/dev-ops/implementation/plan/:path*"],
      ["/implementation/validation", "/settings/dev-ops/events"],
      ["/developers/sdk", "/settings/dev-ops/sdk"],
      ["/developers/debugger", "/settings/dev-ops/debugger"],
      ["/developers/webhooks/:path*", "/settings/dev-ops/webhooks/:path*"],
      ["/attribution", "/acquisition"],
      ["/attribution/links", "/acquisition/links"],
      ["/attribution/settings", "/settings/dev-ops/attribution"],
      ["/attribution/postbacks", "/settings/dev-ops/attribution/postbacks"],
      ["/attribution/skan", "/settings/dev-ops/attribution/skan"],
      ["/deep-links", "/settings/dev-ops/deep-links"],
      ["/deep-links/links", "/acquisition/deep-links"],
      ["/engage/integrations", "/settings/dev-ops/channels"],
      ["/privacy/:path*", "/settings/privacy/:path*"],
    ];
    return moved.map(([from, to]) => ({ source: `${app}${from}`, destination: `${app}${to}`, permanent: false }));
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
