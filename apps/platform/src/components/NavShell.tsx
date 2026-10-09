"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { useT } from "@/i18n/client";

/**
 * The project layout's two columns: the side menu and the page. On wide screens the menu folds
 * away to a thin rail (search on top, a picture per section, the fold button at the bottom), so the page gets the full
 * width; the choice is remembered per browser. Phones keep the drawer (AppNav), so nothing changes there.
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

export function NavShell({ search, nav, rail, children }: { search: ReactNode; nav: ReactNode; rail: ReactNode; children: ReactNode }) {
  const t = useT();
  const collapsed = useSyncExternalStore(subscribe, read, () => false);
  const label = collapsed ? t("Show menu") : t("Hide menu");
  return (
    <div className={`mx-auto grid gap-6 px-4 py-5 lg:py-6 ${collapsed ? "max-w-screen-2xl lg:grid-cols-[2.25rem_1fr]" : "max-w-7xl lg:grid-cols-[220px_1fr]"}`}>
      {/* On wide screens the menu fills the screen's height: search in the top corner, the fold button at the bottom. */}
      <aside className="max-lg:contents lg:sticky lg:top-20 lg:flex lg:h-[calc(100dvh-6rem)] lg:flex-col lg:self-start">
        <div className="max-lg:contents lg:relative lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
          {/* The search stays mounted when folded, so Ctrl+K still opens it. */}
          {search}
          <div className={collapsed ? "max-lg:contents lg:hidden" : "max-lg:contents"}>{nav}</div>
          {collapsed && <div className="hidden pt-11 lg:block">{rail}</div>}
        </div>
        <div className={`hidden border-t border-line pt-2 lg:flex ${collapsed ? "justify-center" : "justify-start"}`}>
          <button
            type="button"
            onClick={() => write(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={label}
            title={label}
            className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-paper-2 hover:text-ink"
          >
            {/* A side panel with a chevron: pointing in to fold, out to unfold (mirrored for Arabic). */}
            <svg aria-hidden viewBox="0 0 20 20" className={`size-[18px] ${collapsed ? "-scale-x-100 rtl:scale-x-100" : "rtl:-scale-x-100"}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <path d="M7.5 3.5v13" />
              <path d="m13 8-2 2 2 2" />
            </svg>
          </button>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
