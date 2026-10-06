/**
 * The LeanApp mark and horizontal lockup (brand guidelines §3). The mark keeps
 * its primary colours in every theme and never mirrors in RTL; in RTL layouts
 * flex order puts it at the start (right) of the wordmark.
 */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={`shrink-0 ${className}`} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#0e1311" />
      <path d="M10 8v16h12" fill="none" stroke="#f4f2ec" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="22" cy="10" r="3" fill="var(--color-signal)" />
    </svg>
  );
}

/** Mark + "LeanApp" in Dubai Bold. Mark height ≈ 1.6 × cap height, gap = half the mark. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <LogoMark size={24} />
      <span className="text-[21px] font-bold leading-none tracking-[-0.01em] text-ink">LeanApp</span>
    </span>
  );
}
