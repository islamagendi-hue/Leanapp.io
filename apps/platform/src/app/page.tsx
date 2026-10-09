import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { startDemoAction } from "@/app/actions/demo";
import { Logo } from "@/components/Logo";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { getTheme } from "@/lib/theme";
import { demoEnabled } from "@/modules/marketing/demo";
import { COMPETITORS, CONTACT_EMAIL, landingCopy, type Availability, type Coverage } from "@/modules/marketing/landing";
import { getLang } from "@/i18n/server";
import { currentUser } from "@/server/session";

export const metadata = {
  title: { absolute: "LeanApp: product analytics for mobile apps in the Arab world · لين آب" },
  description: "Know your users. Grow your app. Analytics, funnels, retention and campaigns for mobile apps, in Arabic and English.",
};

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

export default async function Home(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const lang = sp.lang === "ar" || sp.lang === "en" ? sp.lang : await getLang();
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
          <nav className="hidden items-center gap-6 text-sm text-ink-2 md:flex" aria-label={lang === "ar" ? "الأقسام" : "Sections"}>
            <a href="#demo" className="hover:text-ink">{t.nav.demo}</a>
            <a href="#how" className="hover:text-ink">{t.nav.how}</a>
            <a href="#compare" className="hover:text-ink">{t.nav.compare}</a>
            <a href="#pricing" className="hover:text-ink">{t.nav.pricing}</a>
            <a href="#about" className="hover:text-ink">{t.nav.about}</a>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <Suspense><ThemeSwitch current={theme} compact /></Suspense>
            <a href={`/lang?to=${other}&next=/`} hrefLang={other} lang={other} className="text-ink-2 hover:text-ink">{t.nav.other}</a>
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
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-14 pt-12 md:pt-20">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-ink">{t.hero.eyebrow}</p>
          <h1 className="mt-4 max-w-4xl text-4xl font-bold leading-tight text-balance md:text-6xl">{t.hero.title}</h1>
          <p className="mt-5 max-w-2xl text-lg text-ink-2">{t.hero.lead}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <DemoButton label={t.hero.demo} />
            <Link href={start} className="btn-secondary">{t.hero.start}</Link>
          </div>
          <p className="mt-3 text-sm text-ink-3">{t.hero.note}</p>
          <ol className="mt-10 flex flex-wrap items-center gap-2 text-sm" aria-label={t.flowLabel}>
            {t.flow.map((s, i) => (
              <li key={s.step} className="flex items-center gap-2">
                <a href={`#step-${i + 1}`} className="pill border-line hover:border-line-strong">{s.step}</a>
                {i < t.flow.length - 1 && <span aria-hidden className="text-ink-3 rtl:-scale-x-100">→</span>}
              </li>
            ))}
          </ol>
        </section>

        <section id="demo" aria-labelledby="demo-title" className="scroll-mt-20 border-y border-line bg-card">
          <div className="mx-auto max-w-6xl px-4 py-14">
            <h2 id="demo-title" className="text-2xl font-bold md:text-3xl">{t.demo.title}</h2>
            <p className="mt-3 max-w-2xl text-ink-2">{t.demo.lead}</p>
            <div className="mt-8 grid gap-6 md:grid-cols-2">
              {t.demo.shots.map((s) => (
                <figure key={s.src} className="min-w-0">
                  <div className="overflow-hidden rounded-xl border border-line bg-paper shadow-sm">
                    <Image src={s.src} alt={s.caption} width={1440} height={900} className="h-auto w-full" sizes="(min-width: 768px) 560px, 100vw" />
                  </div>
                  <figcaption className="mt-2 text-sm text-ink-2">{s.caption}</figcaption>
                </figure>
              ))}
            </div>
            <div className="mt-8"><DemoButton label={t.demo.cta} /></div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-14">
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

        <section id="compare" aria-labelledby="compare-title" className="scroll-mt-20 border-t border-line bg-card">
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

        <section id="features" aria-labelledby="features-title" className="scroll-mt-20 border-y border-line">
          <div className="mx-auto max-w-6xl space-y-10 px-4 py-14">
            <div>
              <h2 id="features-title" className="text-2xl font-bold md:text-3xl">{t.features.title}</h2>
              <p className="mt-3 max-w-2xl text-ink-2">{t.features.lead}</p>
            </div>
            {t.flow.map((s, i) => (
              <article key={s.step} id={`step-${i + 1}`} aria-labelledby={`step-${i + 1}-title`} className="grid scroll-mt-20 gap-4 md:grid-cols-[220px_1fr]">
                <div>
                  <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")} · {s.step}</span>
                  <h3 id={`step-${i + 1}-title`} className="h2 mt-1">{s.title}</h3>
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
              <h3 className="h2">{t.features.coming}</h3>
              <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-card">
                {t.coming.map((c) => (
                  <li key={c} className="flex items-center justify-between gap-3 px-4 py-2.5"><span>{c}</span><State state="coming" /></li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-ink-3">{t.notOffered}</p>
            </div>
          </div>
        </section>

        <section id="pricing" aria-labelledby="pricing-title" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-14">
          <h2 id="pricing-title" className="text-2xl font-bold md:text-3xl">{t.pricing.title}</h2>
          <p className="mt-3 max-w-2xl text-ink-2">{t.pricing.lead}</p>
          <ul className="mt-8 grid gap-4 md:grid-cols-3">
            {t.pricing.plans.map((p) => (
              <li key={p.id} aria-labelledby={`plan-${p.id}`} className={`card flex flex-col gap-4 ${p.featured ? "border-accent ring-1 ring-accent" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <h3 id={`plan-${p.id}`} className="font-bold">{t.pricing.names[p.id]}</h3>
                  {p.featured && <span className="pill border-accent text-accent-ink">{t.pricing.popular}</span>}
                </div>
                <p className="text-sm text-ink-2">{p.tagline}</p>
                <p className="tabular-nums">
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
                    <Link href={start} className={`${p.featured ? "btn" : "btn-secondary"} w-full`}>{t.pricing.start}</Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-ink-2">{t.pricing.all}</p>
        </section>

        <section id="about" aria-labelledby="about-title" className="scroll-mt-20 border-y border-line bg-card">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1fr_1fr]">
            <div className="min-w-0">
              <h2 id="about-title" className="text-2xl font-bold md:text-3xl">{t.about.title}</h2>
              {t.about.body.map((p) => <p key={p} className="mt-4 text-ink-2">{p}</p>)}
            </div>
            <ul className="grid min-w-0 gap-4">
              {t.about.values.map((v) => (
                <li key={v.title} className="rounded-xl border border-line bg-paper p-5">
                  <h3 className="font-bold">{v.title}</h3>
                  <p className="mt-1 text-sm text-ink-2">{v.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="faq" aria-labelledby="faq-title" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-14">
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
          <span>© {new Date().getFullYear()} {t.footer.rights} · leanapp.io</span>
          <span>{t.footer.contact}: <a href={`mailto:${CONTACT_EMAIL}`} className="underline" dir="ltr">{CONTACT_EMAIL}</a></span>
        </div>
      </footer>
    </div>
  );
}
