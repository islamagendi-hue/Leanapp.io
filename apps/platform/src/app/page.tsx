import Link from "next/link";
import { Logo } from "@/components/Logo";
import { AVAILABILITY_LABELS, COMING, FLOW, NOT_OFFERED, type Availability } from "@/modules/marketing/landing";
import { currentUser } from "@/server/session";

export const metadata = { title: { absolute: "LeanApp: affordable product analytics and growth infrastructure for mobile apps" } };

const STATE_STYLE: Record<Availability, string> = {
  live: "border-accent bg-accent text-paper",
  beta: "border-warn/50 bg-warn-soft text-warn",
  coming: "border-line text-ink-3",
};

function State({ state }: { state: Availability }) {
  return <span className={`pill shrink-0 text-xs ${STATE_STYLE[state]}`}>{AVAILABILITY_LABELS[state]}</span>;
}

export default async function Home() {
  const user = await currentUser();
  const start = user ? "/onboarding" : "/signup";
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <Link href="/" aria-label="LeanApp home"><Logo /></Link>
        <nav className="flex items-center gap-4 text-sm">
          {user ? (
            <Link href="/onboarding" className="btn">Open dashboard</Link>
          ) : (
            <>
              <Link href="/login" className="text-ink-2 hover:text-ink">Sign in</Link>
              <Link href="/signup" className="btn">Get started</Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-14 pt-12 md:pt-20">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-ink">For mobile apps</p>
          <h1 className="mt-4 max-w-4xl text-4xl font-bold leading-tight md:text-6xl">Affordable product analytics and growth infrastructure for mobile apps.</h1>
          <p className="mt-5 max-w-2xl text-lg text-ink-2">
            Connect your app, collect clean events, understand what users do, and act on it, on one event stream you can trust. Each step below says plainly
            whether it is live, in beta or still coming.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={start} className="btn">Get started</Link>
            <a href="#how" className="btn-secondary">How it works</a>
          </div>
          <ol className="mt-10 flex flex-wrap items-center gap-2 text-sm" aria-label="Product flow">
            {FLOW.map((s, i) => (
              <li key={s.step} className="flex items-center gap-2">
                <a href={`#${s.step.toLowerCase()}`} className="pill border-line hover:border-line-strong">{s.step}</a>
                {i < FLOW.length - 1 && <span aria-hidden className="text-ink-3">→</span>}
              </li>
            ))}
          </ol>
        </section>

        <section id="how" className="border-y border-line bg-card">
          <div className="mx-auto max-w-6xl space-y-10 px-4 py-14">
            {FLOW.map((s, i) => (
              <article key={s.step} id={s.step.toLowerCase()} aria-labelledby={`${s.step}-title`} className="grid scroll-mt-6 gap-4 md:grid-cols-[220px_1fr]">
                <div>
                  <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")} · {s.step}</span>
                  <h2 id={`${s.step}-title`} className="h2 mt-1">{s.title}</h2>
                </div>
                <div className="space-y-3">
                  <p className="text-ink-2">{s.body}</p>
                  <ul className="divide-y divide-line rounded-xl border border-line bg-paper">
                    {s.items.map((it) => (
                      <li key={it.name} className="flex items-start justify-between gap-3 px-4 py-2.5">
                        <span><span className="font-medium">{it.name}</span>{it.note && <span className="block text-sm text-ink-3">{it.note}</span>}</span>
                        <State state={it.state} />
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-3">
          <div>
            <h3 className="font-medium">Priced for growing apps</h3>
            <p className="mt-2 text-sm text-ink-2">One product for the analytics and engagement most teams buy as several tools, so a small team can afford to measure properly.</p>
          </div>
          <div>
            <h3 className="font-medium">Isolation by default</h3>
            <p className="mt-2 text-sm text-ink-2">Each customer&apos;s data is separated at the database level. Development, staging and production have their own keys and never mix.</p>
          </div>
          <div>
            <h3 className="font-medium">Explainable, not magic</h3>
            <p className="mt-2 text-sm text-ink-2">Every recommended event says why it is there. Plans are versioned, and changes wait for a person to approve them.</p>
          </div>
        </section>

        <section id="coming" className="mx-auto max-w-6xl px-4 pb-20" aria-labelledby="coming-title">
          <h2 id="coming-title" className="h2">Coming next</h2>
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-card">
            {COMING.map((c) => (
              <li key={c} className="flex items-center justify-between gap-3 px-4 py-2.5"><span>{c}</span><State state="coming" /></li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-ink-3">{NOT_OFFERED}</p>
          <div className="mt-8"><Link href={start} className="btn">Get started</Link></div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-ink-3">
          <span>© {new Date().getFullYear()} LeanApp · leanapp.io</span>
          <span>api.leanapp.io · app.leanapp.io</span>
        </div>
      </footer>
    </div>
  );
}
