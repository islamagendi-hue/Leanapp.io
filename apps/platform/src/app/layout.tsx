import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";
import { connection } from "next/server";
import { I18nProvider } from "@/i18n/client";
import { clientDictionary } from "@/i18n/server";
import { getLocale } from "@/lib/locale";
import { marketingOnly } from "@/lib/marketing-only";
import { getTheme } from "@/lib/theme";
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
  // Only the public site of a marketing-only deployment is for search engines; staging and the app are not.
  robots: marketingOnly() ? { index: true, follow: true } : { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f2ec" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1311" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page renders per request so Next.js can apply the CSP nonce set in proxy.ts.
  await connection();
  const { lang, dir } = await getLocale();
  const theme = await getTheme();
  return (
    <html lang={lang} dir={dir} data-theme={theme === "system" ? undefined : theme} className={`${dubai.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh antialiased">
        <I18nProvider lang={lang} dict={await clientDictionary()}>{children}</I18nProvider>
      </body>
    </html>
  );
}
