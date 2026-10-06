"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Tabs across organization settings; only the tabs the member's role can open are passed in. */
export function SettingsNav({ tabs }: { tabs: { label: string; href: string }[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b border-line text-sm">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={path === t.href ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 ${path === t.href ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
