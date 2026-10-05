"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { label: string; href?: string; soon?: boolean };
type Group = { label: string; items: Item[] };

/** Product navigation. Sections not built yet are listed and labelled, never faked. */
export function AppNav({ base, appName }: { base: string; appName: string }) {
  const path = usePathname();
  const groups: Group[] = [
    { label: "Overview", items: [{ label: "Setup", href: base }] },
    {
      label: "Implementation",
      items: [
        { label: "Questions", href: `${base}/implementation/questions` },
        { label: "Tracking plan", href: `${base}/implementation/plan` },
        { label: "Validation & mapping", href: `${base}/implementation/validation` },
      ],
    },
    {
      label: "Developers",
      items: [
        { label: "SDK & API keys", href: `${base}/developers/sdk` },
        { label: "Event debugger", href: `${base}/developers/debugger` },
        { label: "Webhooks", soon: true },
      ],
    },
    { label: "Analytics", items: [{ label: "Events, funnels, retention", soon: true }, { label: "Users", soon: true }] },
    { label: "Attribution", items: [{ label: "Campaigns & sources", soon: true }] },
    { label: "Engagement", items: [{ label: "Audiences", soon: true }, { label: "Automations", soon: true }, { label: "Integrations", soon: true }] },
  ];
  return (
    <nav aria-label="App" className="text-sm">
      <p className="mb-4 truncate px-2 text-base font-bold">{appName}</p>
      {groups.map((g) => (
        <div key={g.label} className="mb-4">
          <p className="mb-1 px-2 font-mono text-[11px] uppercase tracking-wide text-ink-3">{g.label}</p>
          <ul>
            {g.items.map((i) =>
              i.href ? (
                <li key={i.label}>
                  <Link
                    href={i.href}
                    className={`block rounded-md px-2 py-1.5 ${path === i.href ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
                  >
                    {i.label}
                  </Link>
                </li>
              ) : (
                <li key={i.label} className="flex items-center justify-between px-2 py-1.5 text-ink-3" title="Not built yet: see the roadmap">
                  {i.label}
                  <span className="pill border-line text-[10px]">Soon</span>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}
    </nav>
  );
}
