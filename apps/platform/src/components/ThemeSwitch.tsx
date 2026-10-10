"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useT } from "@/i18n/client";
import type { Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; icon: string }[] = [
  { value: "light", icon: "☀" },
  { value: "dark", icon: "☾" },
  { value: "system", icon: "◐" },
];

/** Light / Dark / Auto links that come back to this page (see /theme). */
export function ThemeSwitch({ current, compact = false }: { current: Theme; compact?: boolean }) {
  const t = useT();
  const path = usePathname();
  const qs = useSearchParams().toString();
  const next = encodeURIComponent(qs ? `${path}?${qs}` : path);
  const href = (to: Theme) => `/theme?to=${to}&next=${next}`;
  if (compact) {
    // One button: switches to the opposite of what is shown now.
    const to: Theme = current === "dark" ? "light" : "dark";
    return (
      <a href={href(to)} className="text-ink-2 hover:text-ink" aria-label={to === "dark" ? t("Dark mode") : t("Light mode")} title={to === "dark" ? t("Dark mode") : t("Light mode")}>
        <span aria-hidden>{to === "dark" ? "☾" : "☀"}</span>
      </a>
    );
  }
  return (
    <span role="group" aria-label={t("Appearance")} className="inline-flex overflow-hidden rounded-md border border-line text-xs">
      {OPTIONS.map((o) => (
        <a
          key={o.value}
          href={href(o.value)}
          aria-current={o.value === current ? "true" : undefined}
          className={`px-2 py-1 ${o.value === current ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}
        >
          <span aria-hidden>{o.icon} </span>
          {o.value === "light" ? t("Light") : o.value === "dark" ? t("Dark") : t("Auto")}
        </a>
      ))}
    </span>
  );
}
