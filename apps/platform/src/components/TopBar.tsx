"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { useT } from "@/i18n/client";
import { msg } from "@/i18n/translate";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import type { Theme } from "@/lib/theme";
import { DEFAULT_ENVIRONMENT, ENV_COOKIE, ENVIRONMENT_ORDER, isEnvironmentName, type EnvironmentName } from "@/lib/environment";

type Option = { slug: string; name: string };

const ENV_LABELS: Record<EnvironmentName, string> = { development: msg("Development"), staging: msg("Staging"), production: msg("Production") };

/** The project slug in /o/{org}/apps/{app}/…, if the page belongs to a project. */
function projectInPath(path: string): string | undefined {
  const slug = path.match(/^\/o\/[^/]+\/apps\/([^/]+)/)?.[1];
  return slug && slug !== "new" ? decodeURIComponent(slug) : undefined;
}

/** A small dropdown on <details>; closes when an entry is chosen. */
function Menu({ label, title, children, summary, align = "start" }: { label: string; title: string; children: ReactNode; summary?: ReactNode; align?: "start" | "end" }) {
  const close = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) e.currentTarget.closest("details")?.removeAttribute("open");
  };
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 hover:bg-paper-2" title={title} aria-label={summary ? label : undefined}>
        {summary ?? <span className="max-w-[12rem] truncate">{label}</span>}
        <span aria-hidden className="text-xs text-ink-3">▾</span>
      </summary>
      <div onClick={close} className={`absolute ${align === "end" ? "end-0" : "start-0"} z-30 mt-1 min-w-56 rounded-lg border border-line bg-card p-1 text-sm shadow-lg`}>{children}</div>
    </details>
  );
}

const itemClass = (current: boolean) => `block rounded-md px-3 py-1.5 ${current ? "bg-paper-2 font-medium" : "hover:bg-paper-2"}`;

export function WorkspaceSwitcher({ current, workspaces }: { current: Option; workspaces: Option[] }) {
  const t = useT();
  return (
    <Menu label={current.name} title={t("Switch workspace")}>
      <p className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-wide text-ink-3">{t("Workspaces")}</p>
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
      <p className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-wide text-ink-3">{t("Projects")}</p>
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
    <Link href={`/o/${org}/apps/${encodeURIComponent(app)}/settings/project/environments`} className="pill border-warn/40 bg-warn-soft text-warn" title={t("Change environment")}>
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
