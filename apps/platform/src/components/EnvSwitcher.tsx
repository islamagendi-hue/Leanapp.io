import Link from "next/link";

const ORDER = ["development", "staging", "production"] as const;

/** Environment tabs. `query` keeps other search params (e.g. report settings) when switching. */
export function EnvSwitcher({ path, current, query }: { path: string; current: string; query?: Record<string, string | string[] | undefined> }) {
  const href = (env: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (k === "env" || v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) q.append(k, item);
    }
    q.set("env", env);
    return `${path}?${q}`;
  };
  return (
    <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-sm" role="tablist" aria-label="Environment">
      {ORDER.map((t) => (
        <Link
          key={t}
          href={href(t)}
          role="tab"
          aria-selected={t === current}
          className={`rounded-md px-3 py-1.5 capitalize ${t === current ? (t === "production" ? "bg-alert text-paper" : "bg-ink text-paper") : "text-ink-2 hover:bg-paper-2"}`}
        >
          {t}
        </Link>
      ))}
    </div>
  );
}
