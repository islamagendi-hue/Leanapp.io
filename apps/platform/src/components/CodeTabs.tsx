"use client";

import { useState } from "react";

export function CodeTabs({ tabs, preferred }: { tabs: { key: string; label: string; code: string; note?: string }[]; preferred?: string }) {
  const [active, setActive] = useState(preferred && tabs.some((t) => t.key === preferred) ? preferred : tabs[0]?.key);
  const [copied, setCopied] = useState(false);
  const tab = tabs.find((t) => t.key === active) ?? tabs[0];
  if (!tab) return null;
  return (
    <div>
      <div className="flex flex-wrap gap-1" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab.key}
            onClick={() => setActive(t.key)}
            className={`rounded-md px-2.5 py-1 text-xs ${t.key === tab.key ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab.note && <p className="mt-2 rounded-md bg-warn-soft px-2 py-1 text-xs text-warn">{tab.note}</p>}
      <div className="relative mt-2">
        <pre className="code whitespace-pre">{tab.code}</pre>
        <button
          type="button"
          className="absolute end-2 top-2 rounded bg-paper/15 px-2 py-0.5 text-xs text-paper hover:bg-paper/25"
          onClick={async () => {
            await navigator.clipboard.writeText(tab.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
