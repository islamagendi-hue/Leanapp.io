"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NavGroup } from "@/modules/navigation/menu";

interface Item { label: string; hint: string; href: string; words: string }

/**
 * Ctrl+K (⌘K on a Mac) or the search button: jump to any page of the project,
 * open an event's report, or look a user up by ID, without leaving the keyboard.
 * Pages come from the member's own menus, so it never offers a page they can't open.
 */
export function QuickSearch({ base, menu, settings, events, canUsers }: {
  base: string; menu: NavGroup[]; settings: NavGroup[]; events: { name: string; label: string }[]; canUsers: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const mac = useSyncExternalStore(() => () => {}, () => /Mac|iPhone|iPad/.test(navigator.platform), () => false);

  const pages = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const add = (groups: NavGroup[], area: string) => {
      for (const g of groups) {
        if (g.href && g.items.length === 0) out.push({ label: g.label, hint: area, href: g.href, words: `${g.label} ${area}` });
        for (const i of g.items) if (i.href) out.push({ label: i.label, hint: `${area} · ${g.label}`, href: i.href, words: `${i.label} ${g.label} ${area}` });
      }
    };
    add(menu, "Page");
    add(settings, "Settings");
    return out;
  }, [menu, settings]);

  const items = useMemo<Item[]>(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const eventItems = events.map((e) => ({ label: e.label, hint: `Event · ${e.name}`, href: `${base}/analytics/events?event=${encodeURIComponent(e.name)}`, words: `${e.label} ${e.name} event` }));
    const list = [...pages, ...eventItems].filter((i) => !words.length || hit(i.words));
    if (canUsers && q.trim()) list.push({ label: `Find user “${q.trim()}”`, hint: "Users", href: `${base}/analytics/users?q=${encodeURIComponent(q.trim())}`, words: "" });
    return list.slice(0, 12);
  }, [q, pages, events, base, canUsers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function open() {
    setQ("");
    setAt(0);
    if (!dialog.current?.open) dialog.current?.showModal();
    setTimeout(() => input.current?.focus(), 0);
  }
  function go(item: Item | undefined) {
    if (!item) return;
    dialog.current?.close();
    router.push(item.href);
  }

  return (
    <>
      <button type="button" onClick={open} className="mb-3 flex w-full items-center justify-between rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-3 hover:border-line-strong">
        <span>Search…</span>
        <kbd className="font-mono text-[11px]">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <dialog
        ref={dialog}
        aria-label="Quick search"
        className="mx-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-line bg-card p-0 text-ink shadow-2xl backdrop:bg-ink/30"
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt((x) => Math.min(x + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setAt((x) => Math.max(x - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); go(items[at]); }
          }}
          placeholder="Search pages, events, or a user ID…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-base outline-none"
          aria-controls="quick-results"
          aria-activedescendant={items[at] ? `quick-${at}` : undefined}
        />
        <ul id="quick-results" role="listbox" className="max-h-80 overflow-auto p-1">
          {items.length === 0 && <li className="px-3 py-2 text-sm text-ink-3">Nothing matches.</li>}
          {items.map((item, i) => (
            <li key={item.href + item.label} id={`quick-${i}`} role="option" aria-selected={i === at}
              onMouseEnter={() => setAt(i)} onClick={() => go(item)}
              className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-sm ${i === at ? "bg-accent-soft text-accent-ink" : ""}`}>
              <span className="truncate">{item.label}</span>
              <span className="shrink-0 truncate text-xs text-ink-3">{item.hint}</span>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
