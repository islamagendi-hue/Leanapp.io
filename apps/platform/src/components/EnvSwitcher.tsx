import Link from "next/link";

const ORDER = ["development", "staging", "production"] as const;

export function EnvSwitcher({ path, current }: { path: string; current: string }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-sm" role="tablist" aria-label="Environment">
      {ORDER.map((t) => (
        <Link
          key={t}
          href={`${path}?env=${t}`}
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
