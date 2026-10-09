"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { DRAWER_ID } from "@/components/AppNav";
import { QUICK_SEARCH_EVENT } from "@/components/QuickSearch";
import type { Theme } from "@/lib/theme";
import { DEFAULT_ENVIRONMENT, ENV_COOKIE, ENVIRONMENT_ORDER, isEnvironmentName, type EnvironmentName } from "@/lib/environment";

type Option = { slug: string; name: string };

const ENV_LABELS: Record<EnvironmentName, string> = { development: msg("Development"), staging: msg("Staging"), production: msg("Production") };

/** The project slug in /o/{org}/apps/{app}/…, if the page belongs to a project. */
function projectInPath(path: string): string | undefined {
  const slug = path.match(/^\/o\/[^/]+\/apps\/([^/]+)/)?.[1];
  return slug && slug !== "new" ? decodeURIComponent(slug) : undefined;
}

/** How long the pointer may stray off an open menu before it closes. */
const LEAVE_DELAY_MS = 300;

/**
 * A small dropdown on <details>. It closes when an entry is chosen, on a click
 * or tap outside it, on Escape, and when a mouse pointer leaves it for a moment.
 */
function Menu({ label, title, children, summary, align = "start" }: { label: string; title: string; children: ReactNode; summary?: ReactNode; align?: "start" | "end" }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const shut = () => ref.current?.removeAttribute("open");
  const close = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) shut();
  };
  const leave = (e: PointerEvent<HTMLDetailsElement>) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(shut, LEAVE_DELAY_MS);
  };
  const enter = () => clearTimeout(timer.current);

  useEffect(() => {
    if (!open) return;
    const outside = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) shut();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      shut();
      ref.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      clearTimeout(timer.current);
    };
  }, [open]);

  return (
    <details ref={ref} className="relative" onToggle={(e) => setOpen(e.currentTarget.open)} onPointerLeave={leave} onPointerEnter={enter}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-md px-2 hover:bg-paper-2 lg:min-h-8" title={title} aria-label={summary ? label : undefined}>
        {summary ?? <span className="max-w-[6.5rem] truncate sm:max-w-[12rem]">{label}</span>}
        <span aria-hidden className="text-xs text-ink-3 max-sm:hidden">▾</span>
      </summary>
      <div onClick={close} className={`absolute ${align === "end" ? "end-0" : "start-0"} z-30 mt-1 min-w-56 rounded-lg border border-line bg-card p-1 text-sm shadow-lg`}>{children}</div>
    </details>
  );
}

const itemClass = (current: boolean) => `flex min-h-11 items-center rounded-md px-3 lg:min-h-0 lg:py-1.5 ${current ? "bg-paper-2 font-medium" : "hover:bg-paper-2"}`;

const iconButton = "grid size-10 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-paper-2 hover:text-ink";

/**
 * Phones only: search and the menu as two icon buttons in the top bar, in place of the
 * search box and the menu above the page. Each shows only where the page has what it
 * opens (globals.css: the quick search dialog, the menu drawer).
 */
export function NavButtons() {
  const t = useT();
  return (
    <div className="flex items-center lg:hidden">
      <button type="button" className={`quick-search-btn ${iconButton}`} aria-label={t("Search")} onClick={() => window.dispatchEvent(new Event(QUICK_SEARCH_EVENT))}>
        <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4.5 4.5" /></svg>
      </button>
      <button type="button" className={`nav-drawer-btn ${iconButton}`} aria-label={t("Menu")} popoverTarget={DRAWER_ID}>
        <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 5.5h14M3 10h14M3 14.5h14" /></svg>
      </button>
    </div>
  );
}

/** With the "/" after it. Inside a project on a phone it gives its room to the project's name. */
export function WorkspaceSwitcher({ current, workspaces }: { current: Option; workspaces: Option[] }) {
  const inProject = Boolean(projectInPath(usePathname()));
  return (
    <div className={`flex min-w-0 items-center gap-0.5 sm:gap-1 ${inProject ? "max-sm:hidden" : ""}`}>
      <WorkspaceMenu current={current} workspaces={workspaces} />
      <span aria-hidden className="text-ink-3">/</span>
    </div>
  );
}

function WorkspaceMenu({ current, workspaces }: { current: Option; workspaces: Option[] }) {
  const t = useT();
  return (
    <Menu label={current.name} title={t("Switch workspace")}>
      <p className="px-3 pb-1 pt-2 eyebrow">{t("Workspaces")}</p>
      {workspaces.map((w) => (
        <Link key={w.slug} href={`/o/${w.slug}`} className={itemClass(w.slug === current.slug)}>{w.name}</Link>
      ))}
      <hr className="my-1 border-line" />
      <Link href={`/o/${current.slug}/settings`} className={itemClass(false)}>{t("Workspace settings")}</Link>
      <Link href="/onboarding" className={itemClass(false)}>{t("Create a workspace")}</Link>
    </Menu>
  );
}

/** Archived projects aren't offered, but an open one still names itself in the bar. */
export function ProjectSwitcher({ org, projects, archived = [], canCreate }: { org: string; projects: Option[]; archived?: Option[]; canCreate: boolean }) {
  const slug = projectInPath(usePathname());
  const t = useT();
  const current = projects.find((p) => p.slug === slug);
  const openArchived = current ? undefined : archived.find((p) => p.slug === slug);
  return (
    <Menu label={current?.name ?? (openArchived ? t("{name} (archived)", { name: openArchived.name }) : t("All projects"))} title={t("Switch project")}>
      <p className="px-3 pb-1 pt-2 eyebrow">{t("Projects")}</p>
      {projects.map((p) => (
        <Link key={p.slug} href={`/o/${org}/apps/${p.slug}`} className={itemClass(p.slug === slug)}>{p.name}</Link>
      ))}
      {projects.length === 0 && <p className="px-3 py-1.5 text-ink-3">{t("No projects yet.")}</p>}
      <hr className="my-1 border-line" />
      <Link href={`/o/${org}`} className={itemClass(false)}>{t("All projects")}</Link>
      {canCreate && <Link href={`/o/${org}/apps/new`} className={itemClass(false)}>{t("New project")}</Link>}
    </Menu>
  );
}

const readCookie = (): EnvironmentName | undefined => {
  const v = document.cookie.split("; ").find((c) => c.startsWith(`${ENV_COOKIE}=`))?.slice(ENV_COOKIE.length + 1);
  return isEnvironmentName(v) ? v : undefined;
};

/** The environment being viewed: `?env=` in the URL, else the remembered cookie, else production. */
function useViewedEnvironment(initial?: EnvironmentName): EnvironmentName {
  const params = useSearchParams();
  // Re-read on every render (navigation re-renders this); the server's value until hydrated.
  const remembered = useSyncExternalStore(() => () => {}, readCookie, () => initial);
  const fromUrl = params.get("env");
  return isEnvironmentName(fromUrl) ? fromUrl : remembered ?? DEFAULT_ENVIRONMENT;
}

/**
 * In the top bar on project pages, only while a non-production environment is
 * being viewed: names it and links to where it is changed (project settings →
 * Environments), so test data is never mistaken for live data.
 */
export function EnvironmentBadge({ initial, org }: { initial?: EnvironmentName; org: string }) {
  const path = usePathname();
  const t = useT();
  const current = useViewedEnvironment(initial);
  const app = projectInPath(path);
  if (!app || current === "production") return null;
  return (
    <Link href={`/o/${org}/apps/${encodeURIComponent(app)}/settings/project/environments`} className="pill border-warn/40 bg-warn-soft text-warn max-sm:order-last" title={t("Change environment")}>
      {t("Viewing {env} data", { env: t(ENV_LABELS[current]) })}
    </Link>
  );
}

/**
 * The environment selector, in project settings → Environments. Choosing puts `?env=` in the URL,
 * which re-renders the page and keeps links shareable; proxy.ts then remembers it in a cookie so
 * every project page opens on it (pickEnvironment reads it on the server).
 */
export function EnvironmentSelect({ initial }: { initial?: EnvironmentName }) {
  const path = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const current = useViewedEnvironment(initial);
  if (!projectInPath(path)) return null;

  const choose = (env: EnvironmentName) => {
    const q = new URLSearchParams(params);
    q.set("env", env);
    router.push(`${path}?${q}`);
  };

  return (
    <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-xs" role="radiogroup" aria-label={t("Environment")}>
      {ENVIRONMENT_ORDER.map((env) => (
        <button
          key={env}
          type="button"
          role="radio"
          aria-checked={env === current}
          onClick={() => env !== current && choose(env)}
          className={`rounded-md px-2.5 py-1 capitalize ${env === current ? (env === "production" ? "bg-alert text-paper" : "bg-ink text-paper") : "text-ink-2 hover:bg-paper-2"}`}
        >
          {t(ENV_LABELS[env])}
        </button>
      ))}
    </div>
  );
}

/**
 * The signed-in person's menu, top right as in most SaaS apps: who you are and
 * your role here, your profile, the organization's settings you can open, and
 * Sign out.
 */
export function AccountMenu({ name, email, initials, role, links, signOut, theme }: {
  name: string;
  email: string;
  initials: string;
  role: string;
  links: { label: string; href: string }[];
  signOut: () => Promise<void>;
  theme: Theme;
}) {
  const t = useT();
  return (
    <Menu
      label={t("Your account")}
      title={email}
      align="end"
      summary={<span className="grid size-8 place-items-center rounded-full bg-ink text-xs font-bold text-paper">{initials}</span>}
    >
      <div className="px-3 pb-2 pt-2">
        <p className="truncate font-medium text-ink">{name}</p>
        <p className="truncate text-xs text-ink-3">{email}</p>
        <span className="pill mt-1 border-line text-ink-3">{t(role)}</span>
      </div>
      <hr className="my-1 border-line" />
      {links.map((l) => <Link key={l.href} href={l.href} className={itemClass(false)}>{t(l.label)}</Link>)}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-ink-3">{t("Language")}</span>
        <LanguageSwitch className="font-medium text-ink hover:underline" />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <span className="text-ink-3">{t("Appearance")}</span>
        <ThemeSwitch current={theme} />
      </div>
      <hr className="my-1 border-line" />
      <form action={signOut}>
        <button type="submit" className={`${itemClass(false)} w-full text-start`}>{t("Sign out")}</button>
      </form>
    </Menu>
  );
}
