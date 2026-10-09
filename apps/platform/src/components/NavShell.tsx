"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useT } from "@/i18n/client";

/**
 * The project layout's two columns: the side menu and the page. On wide screens the menu folds
 * away to a thin rail with one button, so the page gets the full width; the choice is remembered
 * per browser. Phones keep the drawer (AppNav), so nothing changes there.
 */
const KEY = "leanapp.nav.collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(KEY, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(KEY, cb);
    window.removeEventListener("storage", cb);
  };
}

function write(collapsed: boolean) {
  try {
    localStorage.setItem(KEY, collapsed ? "1" : "0");
  } catch {}
  window.dispatchEvent(new Event(KEY));
}

export function NavShell({ search, nav, children }: { search: ReactNode; nav: ReactNode; children: ReactNode }) {
  const t = useT();
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const label = collapsed ? t("Show menu") : t("Hide menu");
  return (
    <div className={`mx-auto grid gap-6 px-4 py-5 lg:py-6 ${collapsed ? "max-w-screen-2xl lg:grid-cols-[2.25rem_1fr]" : "max-w-7xl lg:grid-cols-[220px_1fr]"}`}>
      <aside className="max-lg:contents lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pb-4">
        <div className={`mb-2 hidden lg:flex ${collapsed ? "justify-center" : "justify-end"}`}>
          <button
            type="button"
            onClick={() => write(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={label}
            title={label}
            className="grid size-8 place-items-center rounded-md border border-line text-ink-2 hover:bg-paper-2 hover:text-ink"
          >
            <span aria-hidden className={`inline-block ${collapsed ? "rtl:-scale-x-100" : "-scale-x-100 rtl:scale-x-100"}`}>→</span>
          </button>
        </div>
        {/* The search stays mounted when folded, so Ctrl+K still opens it; only its button hides. */}
        <div className={collapsed ? "contents lg:[&>button]:hidden" : "contents"}>{search}</div>
        <div className={collapsed ? "max-lg:contents lg:hidden" : "max-lg:contents"}>{nav}</div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
