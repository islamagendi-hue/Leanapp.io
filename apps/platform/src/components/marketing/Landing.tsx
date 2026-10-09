import Link from "next/link";
import { Suspense } from "react";
import { startDemoAction } from "@/app/actions/demo";
import { Logo } from "@/components/Logo";
import { BuildingDashboard } from "@/components/marketing/BuildingDashboard";
import { WorksWith } from "@/components/marketing/WorksWith";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { getTheme } from "@/lib/theme";
import { demoEnabled } from "@/modules/marketing/demo";
import { COMPETITORS, CONTACT_EMAIL, landingCopy, type Availability, type Coverage, type LandingCopy } from "@/modules/marketing/landing";
import { getLang } from "@/i18n/server";
import { currentUser } from "@/server/session";

/** Which landing page is showing: the short home page, or one of the pages its top tabs open. */
export type LandingView = "home" | "features" | "pricing" | "about";
type Lang = "ar" | "en";

const PATHS: Record<LandingView, string> = { home: "/", features: "/features", pricing: "/pricing", about: "/about" };

const COVERAGE_STYLE: Record<Coverage, string> = {
  yes: "text-accent-ink font-medium",
  beta: "text-warn font-medium",
  partial: "text-ink-2",
  no: "text-ink-3",
};
const COVERAGE_MARK: Record<Coverage, string> = { yes: "✓", beta: "◐", partial: "◐", no: "–" };

const STATE_STYLE: Record<Availability, string> = {
  live: "border-accent bg-accent text-paper",
  beta: "border-warn/50 bg-warn-soft text-warn",
  coming: "border-line text-ink-3",
};

/** The demo button: one click signs in to the read-only demo. Without DEMO_ENABLED it goes to sign-up. */
function DemoButton({ label, className = "btn" }: { label: string; className?: string }) {
  if (!demoEnabled()) return <Link href="/signup" className={className}>{label}</Link>;
  return (
    <form action={startDemoAction} className="contents">
      <button type="submit" className={className}>{label}</button>
    </form>
  );
}

/** The top tabs: Demo, How and Compare are sections of the home page; the rest are their own pages. */
function Tabs({ t, lang, view, className }: { t: LandingCopy; lang: Lang; view: LandingView; className: string }) {
  const tab = (href: string, label: string, current = false) => (
    <Link href={href} aria-current={current ? "page" : undefined} className={`shrink-0 whitespace-nowrap hover:text-ink ${current ? "font-medium text-ink" : ""}`}>{label}</Link>
  );
  return (
    <nav className={className} aria-label={lang === "ar" ? "الأقسام" : "Sections"}>
      {tab(`/?lang=${lang}#demo`, t.nav.demo)}
      {tab(`/?lang=${lang}#how`, t.nav.how)}
      {tab(`/?lang=${lang}#compare`, t.nav.compare)}
      {tab(`/features?lang=${lang}`, t.nav.features, view === "features")}
      {tab(`/pricing?lang=${lang}`, t.nav.pricing, view === "pricing")}
      {tab(`/about?lang=${lang}`, t.nav.about, view === "about")}
      {tab(`/developers?lang=${lang}`, t.nav.developers)}
    </nav>
  );
}

export async function Landing({ view, searchParams }: { view: LandingView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const lang: Lang = sp.lang === "ar" || sp.lang === "en" ? sp.lang : await getLang();
  const t = landingCopy(lang);
  const other = lang === "ar" ? "en" : "ar";
  const user = await currentUser();
  const theme = await getTheme();
  const start = user ? "/onboarding" : "/signup";
  const State = ({ state }: { state: Availability }) => <span className={`pill shrink-0 text-xs ${STATE_STYLE[state]}`}>{t.states[state]}</span>;

  return (
    <div className="min-h-dvh" lang={lang} dir={t.dir}>
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" aria-label="LeanApp home"><Logo /></Link>
          <Tabs t={t} lang={lang} view={view} className="hidden items-center gap-6 text-sm text-ink-2 lg:flex" />
          <div className="flex items-center gap-3 text-sm">
            <Suspense><ThemeSwitch current={theme} compact /></Suspense>
            <a href={`/lang?to=${other}&next=${PATHS[view]}`} hrefLang={other} lang={other} className="text-ink-2 hover:text-ink">{t.nav.other}</a>
            {user ? (
              <Link href="/onboarding" className="btn">{t.nav.dashboard}</Link>
            ) : (
              <>
                <Link href="/login" className="hidden text-ink-2 hover:text-ink sm:inline">{t.nav.signIn}</Link>
                <Link href="/signup" className="btn">{t.nav.start}</Link>
              </>
            )}
          </div>
        </div>
        {/* On phones the same tabs scroll sideways under the logo row. */}
        <Tabs t={t} lang={lang} view={view} className="mx-auto flex max-w-6xl gap-5 overflow-x-auto border-t border-line px-4 py-2.5 text-sm text-ink-2 lg:hidden" />
      </header>

      <main>
        {view === "home" && (
          <>
            <section className="mx-auto max-w-6xl px-4 pb-6 pt-12 md:pt-20">
              <p className="font-mono text-xs uppercase tracking-widest text-accent-ink">{t.hero.eyebrow}</p>
              <h1 className="mt-4 max-w-4xl text-4xl font-bold leading-tight text-balance md:text-6xl">{t.hero.title}</h1>
              <p className="mt-5 max-w-2xl text-lg text-ink-2">{t.hero.lead}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <DemoButton label={t.hero.demo} />
                <Link href={start} className="btn-secondary">{t.hero.start}</Link>
              </div>
              <p className="mt-3 text-sm text-ink-3">{t.hero.note}</p>
            </section>

            <section id="demo" aria-labelledby="demo-title" className="mx-auto max-w-6xl scroll-mt-32 px-4 pb-4 pt-8 lg:scroll-mt-20">
              <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
                <div className="min-w-0 max-w-2xl">
                  <h2 id="demo-title" className="text-2xl font-bold md:text-3xl">{t.demo.title}</h2>
                  <p className="mt-2 text-ink-2">{t.demo.lead}</p>
                </div>
                <DemoButton label={t.demo.cta} className="btn-secondary" />
              </div>
              <div className="mt-6">
                <BuildingDashboard copy={t.demo} lang={lang} />
              </div>
            </section>

            <WorksWith title={t.worksWith.title} note={t.worksWith.note} />

            <section id="how" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-32 px-4 py-14 lg:scroll-mt-20">
              <h2 id="how-title" className="text-2xl font-bold md:text-3xl">{t.how.title}</h2>
              <p className="mt-3 max-w-2xl text-ink-2">{t.how.lead}</p>
              <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {t.how.steps.map((s, i) => (
                  <li key={s.title} className="card">
                    <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                    <h3 className="mt-2 font-bold">{s.title}</h3>
                    <p className="mt-2 text-sm text-ink-2">{s.body}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section id="compare" aria-labelledby="compare-title" className="scroll-mt-32 border-t border-line bg-card lg:scroll-mt-20">
              <div className="mx-auto max-w-6xl px-4 py-14">
                <h2 id="compare-title" className="text-2xl font-bold md:text-3xl">{t.compare.title}</h2>
                <p className="mt-3 max-w-3xl text-ink-2">{t.compare.lead}</p>
                <ul className="mt-8 grid gap-4 md:grid-cols-3">
                  {t.compare.value.map((v) => (
                    <li key={v.title} className="rounded-xl border border-line bg-paper p-5">
                      <h3 className="font-bold">{v.title}</h3>
                      <p className="mt-1 text-sm text-ink-2">{v.body}</p>
                    </li>
                  ))}
                </ul>
                <div className="mt-8 overflow-x-auto rounded-xl border border-line bg-paper">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b border-line">
                        <th scope="col" className="px-4 py-3 text-start font-medium text-ink-2">{t.compare.need}</th>
                        {COMPETITORS.map((c, i) => (
                          <th key={c} scope="col" className={`px-4 py-3 text-center font-bold ${i === 0 ? "bg-accent-soft text-accent-ink" : ""}`} dir="ltr">{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {t.compareRows.map((r) => (
                        <tr key={r.need}>
                          <th scope="row" className="px-4 py-3 text-start font-normal">{r.need}</th>
                          {r.cells.map((c, i) => (
                            <td key={COMPETITORS[i]} className={`px-4 py-3 text-center ${COVERAGE_STYLE[c]} ${i === 0 ? "bg-accent-soft/60" : ""}`}>
                              <span aria-hidden>{COVERAGE_MARK[c]} </span>{t.compare.labels[c]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-4 text-sm text-ink-2">{t.compare.honest}</p>
                <p className="mt-2 text-xs text-ink-3">{t.compare.source}</p>
              </div>
            </section>

            <section id="faq" aria-labelledby="faq-title" className="mx-auto max-w-3xl scroll-mt-32 px-4 py-14 lg:scroll-mt-20">
              <h2 id="faq-title" className="text-2xl font-bold md:text-3xl">{t.faq.title}</h2>
              <div className="mt-6 divide-y divide-line rounded-xl border border-line bg-card">
                {t.faq.items.map((f) => (
                  <details key={f.q} className="group px-5 py-4">
                    <summary className="cursor-pointer list-none font-medium marker:hidden">{f.q}</summary>
                    <p className="mt-2 text-sm text-ink-2">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}

        {view === "features" && (
          <section aria-labelledby="features-title">
            <div className="mx-auto max-w-6xl space-y-10 px-4 py-14">
              <div>
                <h1 id="features-title" className="text-3xl font-bold md:text-4xl">{t.features.title}</h1>
                <p className="mt-3 max-w-2xl text-ink-2">{t.features.lead}</p>
                <ol className="mt-6 flex flex-wrap items-center gap-2 text-sm" aria-label={t.flowLabel}>
                  {t.flow.map((s, i) => (
                    <li key={s.step} className="flex items-center gap-2">
                      <a href={`#step-${i + 1}`} className="pill border-line hover:border-line-strong">{s.step}</a>
                      {i < t.flow.length - 1 && <span aria-hidden className="text-ink-3 rtl:-scale-x-100">→</span>}
                    </li>
                  ))}
                </ol>
              </div>
              {t.flow.map((s, i) => (
                <article key={s.step} id={`step-${i + 1}`} aria-labelledby={`step-${i + 1}-title`} className="grid scroll-mt-32 gap-4 md:grid-cols-[220px_1fr] lg:scroll-mt-20">
                  <div>
                    <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")} · {s.step}</span>
                    <h2 id={`step-${i + 1}-title`} className="h2 mt-1">{s.title}</h2>
                  </div>
                  <div className="min-w-0 space-y-3">
                    <p className="text-ink-2">{s.body}</p>
                    <ul className="divide-y divide-line rounded-xl border border-line bg-card">
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
              <div>
                <h2 className="h2">{t.features.coming}</h2>
                <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-card">
                  {t.coming.map((c) => (
                    <li key={c} className="flex items-center justify-between gap-3 px-4 py-2.5"><span>{c}</span><State state="coming" /></li>
                  ))}
                </ul>
                <p className="mt-3 max-w-3xl text-sm text-ink-3">{t.notOffered}</p>
              </div>
            </div>
          </section>
        )}

        {view === "pricing" && (
          <section aria-labelledby="pricing-title" className="mx-auto max-w-6xl px-4 py-14">
            <h1 id="pricing-title" className="text-3xl font-bold md:text-4xl">{t.pricing.title}</h1>
            <p className="mt-3 max-w-2xl text-ink-2">{t.pricing.lead}</p>
            <ul className="mt-8 grid gap-4 lg:grid-cols-3">
              {t.pricing.plans.map((p) => (
                <li key={p.id} aria-labelledby={`plan-${p.id}`} className={`card flex flex-col gap-4 ${p.featured ? "border-accent ring-1 ring-accent" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h2 id={`plan-${p.id}`} className="font-bold">{t.pricing.names[p.id]}</h2>
                    {p.featured && <span className="pill border-accent text-accent-ink">{t.pricing.popular}</span>}
                  </div>
                  <p className="text-sm text-ink-2">{p.tagline}</p>
                  {/* One visual line; the line-balance checker reads the large price and the small "/ month" as two lines, so it skips this price. */}
                  <p className="tabular-nums" data-lb-ignore>
                    {p.price === null ? (
                      <span className="text-3xl font-bold">{t.pricing.custom}</span>
                    ) : (
                      <>
                        {p.from && <span className="text-sm text-ink-3">{t.pricing.from} </span>}
                        <span className="text-3xl font-bold" dir="ltr">${p.price}</span> <span className="text-sm text-ink-3">{t.pricing.month}</span>
                      </>
                    )}
                  </p>
                  <ul className="space-y-1.5 text-sm text-ink-2">
                    {p.features.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className="text-accent">✓</span>{x}</li>)}
                  </ul>
                  <p className="text-xs text-ink-3">{p.limits}</p>
                  <div className="mt-auto">
                    {p.price === null ? (
                      <a href={`mailto:${CONTACT_EMAIL}?subject=LeanApp%20Enterprise`} className="btn-secondary w-full">{t.pricing.contact}</a>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <Link href={start} className={`${p.featured ? "btn" : "btn-secondary"} w-full`}>{t.pricing.start}</Link>
                        <a href={`mailto:${CONTACT_EMAIL}?subject=LeanApp%20demo`} className="block py-2 text-center text-sm font-medium text-accent-ink hover:underline">{t.pricing.demo}</a>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm text-ink-2">{t.pricing.all}</p>
          </section>
        )}

        {view === "about" && (
          <>
            <section aria-labelledby="about-title" className="border-b border-line bg-card">
              <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1fr_1fr]">
                <div className="min-w-0">
                  <h1 id="about-title" className="text-3xl font-bold md:text-4xl">{t.about.title}</h1>
                  {t.about.body.map((p) => <p key={p} className="mt-4 text-ink-2">{p}</p>)}
                </div>
                <ul className="grid min-w-0 gap-4">
                  {t.about.values.map((v) => (
                    <li key={v.title} className="rounded-xl border border-line bg-paper p-5">
                      <h2 className="font-bold">{v.title}</h2>
                      <p className="mt-1 text-sm text-ink-2">{v.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section aria-labelledby="developers-title" className="mx-auto max-w-6xl px-4 py-14">
              <div className="grid gap-8 md:grid-cols-[1fr_1fr]">
                <div className="min-w-0">
                  <h2 id="developers-title" className="text-2xl font-bold md:text-3xl">{t.developers.title}</h2>
                  <p className="mt-3 text-ink-2">{t.developers.lead}</p>
                  <Link href={`/developers?lang=${lang}`} className="btn-secondary mt-6">{t.developers.cta}</Link>
                </div>
                <ul className="grid min-w-0 gap-3">
                  {t.developers.points.map((p) => (
                    <li key={p} className="flex gap-2 rounded-xl border border-line bg-card p-4 text-sm text-ink-2"><span aria-hidden className="text-accent">•</span>{p}</li>
                  ))}
                </ul>
              </div>
            </section>
          </>
        )}

        <section className="mx-auto max-w-6xl px-4 pb-20">
          <div className="rounded-2xl bg-ink px-6 py-10 text-paper md:px-12">
            <h2 className="text-2xl font-bold md:text-3xl">{t.cta.title}</h2>
            <p className="mt-2 text-paper/80">{t.cta.lead}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={start} className="inline-flex min-h-10 items-center rounded-lg bg-paper px-4 text-sm font-medium text-ink hover:bg-paper-2">{t.cta.start}</Link>
              <DemoButton label={t.cta.demo} className="inline-flex min-h-10 items-center rounded-lg border border-paper/40 px-4 text-sm font-medium text-paper hover:bg-paper/10" />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-ink-3">
          <span>© {new Date().getFullYear()} {t.footer.rights} · leanapp.io · <Link href={`/developers?lang=${lang}`} className="underline">{t.footer.developers}</Link></span>
          <span>{t.footer.contact}: <a href={`mailto:${CONTACT_EMAIL}`} className="underline" dir="ltr">{CONTACT_EMAIL}</a></span>
        </div>
      </footer>
    </div>
  );
}
