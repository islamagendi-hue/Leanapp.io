import { WORKS_WITH, type WorksWithId } from "@/modules/marketing/landing";

/**
 * Simple one-colour marks for the "Works with" row, drawn here (no image hosts)
 * in currentColor so they follow the theme. They hint at each brand; the name
 * next to the mark is the accessible label.
 */
const MARKS: Record<WorksWithId, React.ReactNode> = {
  meta: (
    <path d="M2.5 15.2c0-4.1 2-7.7 4.6-7.7 2.4 0 4 2.6 5 4.3 1.6 2.7 3 5.6 5 5.6 1.7 0 2.4-1.6 2.4-3.3 0-3-1.7-6.6-4-6.6-1.9 0-3.4 2.5-4.6 4.6-1.4 2.4-2.9 5.3-5 5.3-1.6 0-2.4-1.2-2.4-2.2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  ),
  snapchat: (
    <path d="M12 3.2c3 0 5 2.2 5 5.1v2.3l1.6-.5c.6-.1.9.6.4 1l-2 1c.6 1.7 1.9 2.9 3.3 3.3-.3.8-1.4 1.1-2.5 1.2-.2.6-.3 1.2-.8 1.2-1 0-2-.4-3 .2-1 .6-1.4 1.1-2 1.1s-1-.5-2-1.1c-1-.6-2-.2-3-.2-.5 0-.6-.6-.8-1.2-1.1-.1-2.2-.4-2.5-1.2 1.4-.4 2.7-1.6 3.3-3.3l-2-1c-.5-.4-.2-1.1.4-1l1.6.5V8.3c0-2.9 2-5.1 5-5.1z" fill="currentColor" />
  ),
  tiktok: (
    <path d="M14 3.5v11.2a3.7 3.7 0 1 1-3.7-3.7M14 3.5c.4 2.6 2.2 4.3 5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "google-ads": (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="4">
      <path d="M10.5 5.5 17.8 18" />
      <path d="M10.5 5.5 7.2 11.2" />
      <circle cx="5.6" cy="17.4" r="0.6" strokeWidth="5" />
    </g>
  ),
  apple: (
    <path d="M16.3 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.9-3-.8-1.5 0-2.9.9-3.7 2.3-1.6 2.8-.4 6.9 1.2 9.1.8 1.1 1.7 2.3 2.8 2.3 1.1-.1 1.6-.7 2.9-.7 1.3 0 1.7.7 2.9.7 1.2 0 2-1.1 2.7-2.2.9-1.3 1.2-2.5 1.2-2.6-.1 0-2.1-.9-2.1-3.7zM14.1 5.9c.6-.8 1.1-1.8.9-2.8-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.7-.9 2.7 1 .1 2-.5 2.6-1.3z" fill="currentColor" />
  ),
  firebase: (
    <path d="M5 18.5 7.6 3.8c.1-.4.6-.5.8-.1l2.7 5 1.4-2.6c.2-.4.7-.4.9 0L19 18.5l-6.4 3.4c-.4.2-.8.2-1.2 0z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
  ),
  whatsapp: (
    <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
      <path d="M3.8 20.2 5 16.1A8.3 8.3 0 1 1 8.1 19z" />
      <path d="M9.2 8.3c-.3 1.6.4 3.3 1.7 4.6s3 2 4.6 1.7l.6-1.4-1.8-.9-.8.8c-.9-.3-1.9-1.3-2.2-2.2l.8-.8-.9-1.8z" strokeWidth="1.2" />
    </g>
  ),
  resend: (
    <path d="M7 20V4h5.6a4 4 0 0 1 0 8H7m5.3 0 5 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  ),
};

export function WorksWith({ title, note }: { title: string; note: string }) {
  return (
    <section aria-labelledby="works-with-title" className="mx-auto max-w-6xl px-4 py-10">
      <h2 id="works-with-title" className="eyebrow text-center">{title}</h2>
      <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-4 sm:gap-x-10">
        {WORKS_WITH.map((w) => (
          <li key={w.id} className="flex items-center gap-2 text-ink-3 transition-colors hover:text-ink" dir="ltr">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false" className="shrink-0">{MARKS[w.id]}</svg>
            <span className="text-lg font-bold tracking-tight">{w.name}</span>
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-5 max-w-2xl text-center text-xs text-ink-3">{note}</p>
    </section>
  );
}
