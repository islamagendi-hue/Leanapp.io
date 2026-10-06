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
