"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useT } from "@/i18n/client";
import { activeHref, type NavGroup } from "@/modules/navigation/menu";

/**
 * A project's side menu. Inside Settings it swaps to the settings menu (Workspace, Project,
 * Dev Ops, Security) with a way back to the product. Both menus are built on the server for the
 * member's role (modules/navigation/menu.ts); this only highlights the current page.
 */
export function AppNav({ base, appName, menu, settings }: { base: string; appName: string; menu: NavGroup[]; settings: NavGroup[] }) {
  const path = usePathname();
  const t = useT();
  const inSettings = path === `${base}/settings` || path.startsWith(`${base}/settings/`);
  return inSettings ? (
    <SideNav title={t("Settings")} back={{ href: base, label: appName }} menu={settings} path={path} />
  ) : (
    <SideNav title={appName} menu={menu} path={path} />
  );
}

const FOLDED_KEY = "leanapp.nav.folded";

function readFolded(): string {
  try {
    return localStorage.getItem(FOLDED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function parseFolded(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function onFoldedChange(cb: () => void) {
  window.addEventListener(FOLDED_KEY, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(FOLDED_KEY, cb);
    window.removeEventListener("storage", cb);
  };
}

export function SideNav({ title, back, menu, path: given }: { title: string; back?: { href: string; label: string }; menu: NavGroup[]; path?: string }) {
  const current = usePathname();
  const t = useT();
  const path = given ?? current;
  const active = activeHref(menu, path);
  // Folded sections are remembered per browser; the section holding the current page always opens.
  const saved = useSyncExternalStore(onFoldedChange, readFolded, () => "[]");
  const here = menu.find((g) => g.items.some((i) => i.href === active))?.label;
  const closed = new Set(parseFolded(saved).filter((l) => l !== here));
  const toggle = (label: string) => {
    const next = new Set(parseFolded(readFolded()));
    if (closed.has(label)) next.delete(label);
    else next.add(label);
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    } catch {}
    window.dispatchEvent(new Event(FOLDED_KEY));
  };
  const link = (href: string, label: string, sub = false) => (
    <Link
      href={href}
      aria-current={href === active ? "page" : undefined}
      className={`flex min-h-11 items-center rounded-md px-3 lg:min-h-0 lg:px-2 lg:py-1.5 ${sub ? "ms-3 text-[13px]" : ""} ${href === active ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
    >
      {t(label)}
    </Link>
  );
  const nav = (
    <nav aria-label={title} className="text-sm">
      {back && (
        <Link href={back.href} className="mb-2 flex min-h-10 items-center gap-1 truncate px-2 text-xs text-ink-3 hover:text-ink lg:min-h-0">
          <span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {back.label}
        </Link>
      )}
      <p className="mb-4 truncate px-2 text-base font-bold">{title}</p>
      {menu.map((g) =>
        g.items.length === 0 && g.href ? (
          <div key={g.label} className="mb-1">{link(g.href, g.label)}</div>
        ) : (
          <div key={g.label} className="mb-3 mt-3">
            <button
              type="button"
              onClick={() => toggle(g.label)}
              aria-expanded={!closed.has(g.label)}
              className="eyebrow mb-1 flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-paper-2 hover:text-ink lg:min-h-0 lg:py-0.5"
            >
              <span aria-hidden className={`inline-block text-[9px] transition-transform ${closed.has(g.label) ? "-rotate-90 rtl:rotate-90" : ""}`}>▼</span>
              {t(g.label)}
              {g.beta && <span className="pill border-line text-[10px] normal-case">{t("Beta")}</span>}
            </button>
            <ul hidden={closed.has(g.label)}>
              {g.items.map((i) => (
                <li key={i.label}>
                  {i.href ? (
                    link(i.href, i.label, i.sub)
                  ) : (
                    <span className="flex min-h-11 items-center justify-between px-3 text-ink-3 lg:min-h-0 lg:px-2 lg:py-1.5" title={t("Not available yet")}>
                      {t(i.label)}
                      <span className="pill border-line text-[10px]">{t("Soon")}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </nav>
  );
  // Phones open the menu as a drawer from the start edge (the menu button is in the top bar,
  // see NavButtons); choosing an entry closes it. It is a popover, so it works without JavaScript.
  return (
    <>
      <div
        id={DRAWER_ID}
        popover="auto"
        className="drawer lg:hidden"
        onClick={(e) => (e.target as HTMLElement).closest("a") && e.currentTarget.hidePopover()}
      >
        <div className="mb-1 flex justify-end">
          <button type="button" popoverTarget={DRAWER_ID} popoverTargetAction="hide" className="grid size-11 place-items-center rounded-lg text-ink-2 hover:bg-paper-2" aria-label={t("Close menu")}>
            <span aria-hidden className="text-xl leading-none">×</span>
          </button>
        </div>
        {nav}
      </div>
      <div className="hidden lg:block">{nav}</div>
    </>
  );
}

/** The id of the phone menu drawer, opened by the menu button in the top bar. */
export const DRAWER_ID = "nav-drawer";
