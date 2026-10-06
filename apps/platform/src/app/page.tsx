import Link from "next/link";
import { Logo } from "@/components/Logo";
import { currentUser } from "@/server/session";

export const metadata = { title: { absolute: "LeanApp: one SDK for mobile growth" } };

const LOOP = [
  ["Tell us your business", "Answer a short questionnaire: business model, revenue, journey, channels, the questions you need answered."],
  ["Get your tracking plan", "Events, properties, user properties and attribution rules generated for your model, each with the reason it exists."],
  ["Approve it", "Versioned plans with draft, approval and publish. Nothing changes production tracking without a person signing off."],
  ["Install and send", "Copy the generated code for your platform, send an event and watch it arrive in the live debugger."],
  ["See your score", "Every event is validated against the plan. The implementation score tells you what is missing before you rely on the data."],
];

const STATUS: { area: string; state: "live" | "building" | "planned"; note: string }[] = [
  { area: "Implementation intelligence", state: "live", note: "Questionnaire, plan generation, versioning, code snippets, validation, mappings, score." },
  { area: "Event ingestion and debugger", state: "live", note: "Batched, idempotent REST API with per-environment keys and a live event debugger." },
  { area: "JavaScript / React Native SDK", state: "live", note: "@leanapp/analytics with offline queue, sessions and retries." },
  { area: "Android, iOS and Flutter SDKs", state: "building", note: "API designed. Use the REST API until they ship." },
  { area: "Attribution", state: "planned", note: "Click ids and campaign parameters are captured now; matching and ad network postbacks come next." },
  { area: "Product analytics", state: "planned", note: "Funnels, retention and cohorts on the events you already send." },
  { area: "Audiences and automation", state: "planned", note: "Segments from behaviour, then push, in-app and webhook journeys." },
];

const STATE_STYLE = { live: "border-accent bg-accent text-paper", building: "border-warn/50 text-warn", planned: "border-line text-ink-3" };

export default async function Home() {
  const user = await currentUser();
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
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-12 md:pt-20">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-ink">Growth infrastructure for mobile apps in MENA</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight md:text-6xl">One SDK for mobile growth.</h1>
          <p className="mt-5 max-w-2xl text-lg text-ink-2">
            Attribution, product analytics and customer automation on one event stream. LeanApp starts from your business model and tells you exactly what to track, why, and whether it is working.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={user ? "/onboarding" : "/signup"} className="btn">Design your tracking plan</Link>
            <a href="#status" className="btn-secondary">What works today</a>
          </div>
        </section>

        <section className="border-y border-line bg-card">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 className="h2">From business questions to a validated implementation</h2>
            <ol className="mt-8 grid gap-6 md:grid-cols-5">
              {LOOP.map(([t, d], i) => (
                <li key={t}>
                  <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                  <p className="mt-1 font-medium">{t}</p>
                  <p className="mt-1 text-sm text-ink-2">{d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-3">
          <div>
            <h3 className="font-medium">Built for how apps here grow</h3>
            <p className="mt-2 text-sm text-ink-2">Delivery, marketplaces, fintech, subscriptions and super apps. Local currencies, Snapchat and TikTok as first-class channels, Arabic-first products.</p>
          </div>
          <div>
            <h3 className="font-medium">Isolation by default</h3>
            <p className="mt-2 text-sm text-ink-2">Each customer&apos;s data is separated at the database level. Development, staging and production have their own keys and never mix.</p>
          </div>
          <div>
            <h3 className="font-medium">Explainable, not magic</h3>
            <p className="mt-2 text-sm text-ink-2">Every recommended event says why it is there. Plans are deterministic and versioned, and suggested changes always wait for approval.</p>
          </div>
        </section>

        <section id="status" className="mx-auto max-w-6xl px-4 pb-20">
          <h2 className="h2">Product status</h2>
          <p className="mt-1 text-sm text-ink-3">We would rather tell you what is not built yet than let you find out.</p>
          <ul className="mt-6 divide-y divide-line rounded-xl border border-line bg-card">
            {STATUS.map((s) => (
              <li key={s.area} className="grid gap-1 px-4 py-3 md:grid-cols-[260px_100px_1fr] md:items-center">
                <span className="font-medium">{s.area}</span>
                <span><span className={`pill ${STATE_STYLE[s.state]}`}>{s.state}</span></span>
                <span className="text-sm text-ink-2">{s.note}</span>
              </li>
            ))}
          </ul>
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
