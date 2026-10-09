"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { activeHref, type NavGroup, type NavIcon } from "@/modules/navigation/menu";

/**
 * A project's side menu. Inside Settings it swaps to the settings menu (Workspace, Project,
 * Dev Ops, Security) with a way back to the product. Both menus are built on the server for the
 * member's role (modules/navigation/menu.ts); this only highlights the current page.
 */
function writeFolded(labels: string[]) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify(labels));
  } catch {}
  window.dispatchEvent(new Event(FOLDED_KEY));
}

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
  // Folded sections are remembered per browser. Any section folds, the current page's too;
  // moving to a page in a folded section opens that section.
  const saved = useSyncExternalStore(onFoldedChange, readFolded, () => "[]");
  const here = menu.find((g) => g.items.some((i) => i.href === active))?.label;
  const closed = new Set(parseFolded(saved));
  const lastHere = useRef(here);
  useEffect(() => {
    if (here === lastHere.current) return;
    lastHere.current = here;
    if (here && parseFolded(readFolded()).includes(here)) writeFolded(parseFolded(readFolded()).filter((l) => l !== here));
  }, [here]);
  const toggle = (label: string) => {
    const next = new Set(parseFolded(readFolded()));
    if (closed.has(label)) next.delete(label);
    else next.add(label);
    writeFolded([...next]);
  };
  const link = (href: string, label: string, sub = false, beta = false) => (
    <Link
      href={href}
      aria-current={href === active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-2 rounded-md px-3 lg:min-h-0 lg:px-2 lg:py-1.5 ${sub ? "ms-3 text-[13px]" : ""} ${href === active ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
    >
      {t(label)}
      {beta && <span className="pill border-current text-[10px] normal-case opacity-70">{t("Beta")}</span>}
    </Link>
  );
  const nav = (
    <nav aria-label={title} className="text-sm">
      {back && (
        <Link href={back.href} className="mb-2 flex min-h-10 items-center gap-1 truncate px-2 text-xs text-ink-3 hover:text-ink lg:min-h-0 lg:pe-10">
          <span aria-hidden className="inline-block rtl:-scale-x-100">←</span> {back.label}
        </Link>
      )}
      <p className="mb-4 truncate px-2 text-base font-bold lg:pe-10">{title}</p>
      {menu.map((g) => (
        <Fragment key={g.label}>
          {g.heading !== undefined && (
            <p className="mb-1 mt-5 border-t border-line px-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-3">{g.heading && t(g.heading)}</p>
          )}
          {g.items.length === 0 && g.href ? (
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
                    link(i.href, i.label, i.sub, i.beta)
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
          )}
        </Fragment>
      ))}
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

const ICONS: Record<NavIcon, ReactNode> = {
  overview: <path d="M3.5 9 10 3.5 16.5 9v7.5h-4.5v-4.5H8v4.5H3.5z" />,
  growth: (
    <>
      <path d="m3 14 4.5-4.5 3 3L17 6" />
      <path d="M12.5 6H17v4.5" />
    </>
  ),
  attribution: (
    <>
      <path d="M8.5 11.5a3.2 3.2 0 0 0 4.6.2l2.4-2.4a3.2 3.2 0 0 0-4.6-4.6l-1 1" />
      <path d="M11.5 8.5a3.2 3.2 0 0 0-4.6-.2l-2.4 2.4a3.2 3.2 0 0 0 4.6 4.6l1-1" />
    </>
  ),
  analyze: <path d="M4 16.5V10M8 16.5V4M12 16.5v-8M16 16.5V7" />,
  segments: (
    <>
      <circle cx="7.5" cy="7" r="2.8" />
      <path d="M2.5 16.5c.4-2.8 2.5-4.5 5-4.5s4.6 1.7 5 4.5" />
      <path d="M13 4.5a2.6 2.6 0 0 1 0 5M14.5 12.3c1.7.5 2.8 2 3 4.2" />
    </>
  ),
  engage: <path d="M17 3 3 9l5.5 2.5L11 17zM8.5 11.5 17 3" />,
  experiments: (
    <>
      <path d="M7.5 3.5h5M8.5 3.5v5L4 16a.9.9 0 0 0 .8 1.4h10.4A.9.9 0 0 0 16 16l-4.5-7.5v-5" />
      <path d="M6 13h8" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
};

/**
 * The folded menu (NavShell's thin rail on wide screens): one picture per section, opening its first
 * page; the section holding the current page is highlighted.
 */
export function NavRail({ base, menu }: { base: string; menu: NavGroup[] }) {
  const path = usePathname();
  const t = useT();
  const inSettings = path === `${base}/settings` || path.startsWith(`${base}/settings/`);
  const active = activeHref(menu, path);
  return (
    <nav aria-label={t("Shortcuts")} className="flex flex-col items-center gap-1">
      {menu.map((g) => {
        const href = g.href ?? g.items.find((i) => i.href)?.href;
        if (!g.icon || !href) return null;
        const here = g.icon === "settings" ? inSettings : !inSettings && (g.href === active || g.items.some((i) => i.href === active));
        return (
          <Link
            key={g.label}
            href={href}
            aria-label={t(g.label)}
            title={t(g.label)}
            aria-current={here ? "page" : undefined}
            className={`grid size-9 place-items-center rounded-md ${g.icon === "settings" ? "mt-2" : ""} ${here ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2 hover:text-ink"}`}
          >
            <svg aria-hidden viewBox="0 0 20 20" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              {ICONS[g.icon]}
            </svg>
          </Link>
        );
      })}
    </nav>
  );
}
