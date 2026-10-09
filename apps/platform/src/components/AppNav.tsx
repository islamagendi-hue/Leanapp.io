"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useT } from "@/i18n/client";
import { activeHref, type NavGroup } from "@/modules/navigation/menu";

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
  const link = (href: string, label: string, sub = false) => (
    <Link
      href={href}
      aria-current={href === active ? "page" : undefined}
      className={`block rounded-md px-2 py-1.5 ${sub ? "ms-3 text-[13px]" : ""} ${href === active ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
    >
      {t(label)}
    </Link>
  );
  const nav = (
    <nav aria-label={title} className="text-sm">
      {back && (
        <Link href={back.href} className="mb-2 block truncate px-2 text-xs text-ink-3 hover:text-ink">
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
              className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-0.5 text-start font-mono text-[11px] uppercase tracking-wide text-ink-3 hover:bg-paper-2 hover:text-ink"
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
                    <span className="flex items-center justify-between px-2 py-1.5 text-ink-3" title={t("Not available yet")}>
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
  // Phones get the menu folded away above the page; it folds again once an entry is chosen.
  return (
    <>
      <details
        className="rounded-lg border border-line bg-card lg:hidden"
        onClick={(e) => (e.target as HTMLElement).closest("a") && e.currentTarget.removeAttribute("open")}
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("Menu")} · {title}</summary>
        <div className="border-t border-line p-2">{nav}</div>
      </details>
      <div className="hidden lg:block">{nav}</div>
    </>
  );
}
