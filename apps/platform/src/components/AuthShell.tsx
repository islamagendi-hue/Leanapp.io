import Link from "next/link";
import { Suspense } from "react";
import { getTheme } from "@/lib/theme";
import { LanguageSwitch } from "./LanguageSwitch";
import { ThemeSwitch } from "./ThemeSwitch";
import { Logo } from "./Logo";

export async function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" aria-label="LeanApp home"><Logo /></Link>
        <div className="flex items-center gap-3 text-sm">
          <Suspense><ThemeSwitch current={await getTheme()} compact /></Suspense>
          <Suspense><LanguageSwitch className="text-sm text-ink-2 hover:text-ink" /></Suspense>
        </div>
      </div>
      <h1 className="h1">{title}</h1>
      {subtitle && <p className="mt-2 text-ink-2">{subtitle}</p>}
      <div className="card mt-6">{children}</div>
      {footer && <div className="mt-4 text-sm text-ink-2">{footer}</div>}
    </main>
  );
}
