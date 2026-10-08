import Link from "next/link";

/** Which environment a dashboard shows, and a link to recompute its widgets now. */
export function EnvironmentNote({ env, refresh }: { env: string; refresh: string }) {
  return (
    <p className="text-xs text-ink-3">
      Showing <strong>{env}</strong> data. Results may be up to 10 minutes old. <Link className="underline" href={refresh}>Refresh now</Link>
    </p>
  );
}
