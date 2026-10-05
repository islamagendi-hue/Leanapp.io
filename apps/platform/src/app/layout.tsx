import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";

const dubai = localFont({
  variable: "--font-dubai",
  display: "swap",
  src: [
    { path: "./fonts/Dubai-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/Dubai-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Dubai-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Dubai-Bold.woff2", weight: "700", style: "normal" },
  ],
});
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "LeanApp: growth infrastructure for mobile apps", template: "%s · LeanApp" },
  description: "Attribution, analytics and automation for mobile apps, with an implementation designed around your business.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f4f2ec", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page renders per request so Next.js can apply the CSP nonce set in proxy.ts.
  await connection();
  return (
    <html lang="en" className={`${dubai.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
