import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { getTheme } from "@/lib/theme";
import { getLang } from "@/i18n/server";
import { CONTACT_EMAIL, type LandingLang } from "@/modules/marketing/landing";
import {
  developersCopy, EXAMPLE_EVENTS, PURPOSES, SDK_FACTS, SDK_IDS, SDK_SNIPPETS, SECTION_IDS, SERVER_SNIPPET, SNIPPET_KEYS, sdkPublished, sdkStatus, type SectionId,
} from "@/modules/marketing/developers";
import { currentUser } from "@/server/session";
import { ACCESS_MAILTO, marketingOnly } from "@/modules/marketing/access";

async function pageLang(sp: Record<string, string | string[] | undefined>): Promise<LandingLang> {
  return sp.lang === "ar" || sp.lang === "en" ? sp.lang : await getLang();
}

export async function generateMetadata(props: PageProps<"/developers">) {
  const t = developersCopy(await pageLang(await props.searchParams));
  return { title: { absolute: t.meta.title }, description: t.meta.description };
}

/** Code stays left to right inside Arabic pages. */
function Code({ code, label }: { code: string; label: string }) {
  return (
    <pre dir="ltr" lang="en" aria-label={label} className="overflow-x-auto rounded-lg border border-line bg-paper-2 p-4 text-start font-mono text-xs leading-relaxed text-ink">
      <code>{code}</code>
    </pre>
  );
}

/** Inline code: package names, method names, keys. */
const C = ({ children }: { children: string }) => <code dir="ltr" className="rounded bg-paper-2 px-1 font-mono text-[0.9em]">{children}</code>;

function Section({ id, title, lead, children, tinted }: { id: SectionId; title: string; lead?: string; children: ReactNode; tinted?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-20 ${tinted ? "border-y border-line bg-card" : ""}`}>
      <div className="mx-auto max-w-5xl px-4 py-12">
        <h2 id={`${id}-title`} className="text-2xl font-bold md:text-3xl">{title}</h2>
        {lead && <p className="mt-3 max-w-3xl text-ink-2">{lead}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="max-w-3xl space-y-2 text-ink-2">
    {items.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className="text-accent">•</span><span>{x}</span></li>)}
  </ul>
);

export default async function Developers(props: PageProps<"/developers">) {
  const lang = await pageLang(await props.searchParams);
  const t = developersCopy(lang);
  const other = lang === "ar" ? "en" : "ar";
  // Marketing-only deployments have no database: no session lookup, and starting means asking us for access.
  const closed = marketingOnly();
  const user = closed ? null : await currentUser();
  const theme = await getTheme();
  const start = closed ? ACCESS_MAILTO : user ? "/onboarding" : "/signup";
  const s = t.sections;

  return (
    <div className="min-h-dvh" lang={lang} dir={t.dir}>
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link href={`/?lang=${lang}`} aria-label="LeanApp home"><Logo /></Link>
          <nav className="hidden items-center gap-6 text-sm text-ink-2 lg:flex" aria-label={t.nav.sections}>
            <Link href={`/?lang=${lang}`} className="hover:text-ink">{t.nav.home}</Link>
            <a href="#sdks" className="hover:text-ink">{s.sdks}</a>
            <a href="#quickstart" className="hover:text-ink">{s.quickstart}</a>
            <a href="#code" className="hover:text-ink">{s.code}</a>
            <a href="#notes" className="hover:text-ink">{s.notes}</a>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <Suspense><ThemeSwitch current={theme} compact /></Suspense>
            <a href={`/lang?to=${other}&next=/developers`} hrefLang={other} lang={other} className="text-ink-2 hover:text-ink">{t.nav.other}</a>
            {closed ? (
              <a href={ACCESS_MAILTO} className="btn">{t.nav.requestAccess}</a>
            ) : user ? (
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
        <section className="mx-auto max-w-5xl px-4 pb-10 pt-12 md:pt-16">
          <p className="font-mono text-xs uppercase tracking-widest text-accent-ink">{t.hero.eyebrow}</p>
          <h1 className="mt-4 max-w-4xl text-4xl font-bold leading-tight text-balance md:text-5xl">{t.hero.title}</h1>
          <p className="mt-5 max-w-3xl text-lg text-ink-2">{t.hero.lead}</p>
          <p className="mt-5 max-w-3xl rounded-xl border border-warn/50 bg-warn-soft px-4 py-3 text-sm text-ink">{t.hero.status}</p>
          <nav aria-label={t.toc} className="mt-8">
            <p className="text-sm font-medium text-ink-3">{t.toc}</p>
            <ol className="mt-2 flex flex-wrap gap-2 text-sm">
              {SECTION_IDS.map((id) => <li key={id}><a href={`#${id}`} className="pill border-line hover:border-line-strong">{s[id]}</a></li>)}
            </ol>
          </nav>
        </section>

        <Section id="sdks" title={s.sdks} lead={t.sdks.lead} tinted>
          <ul className="grid gap-4 md:grid-cols-2">
            {SDK_IDS.map((id) => {
              const card = t.sdks.cards[id];
              const f = SDK_FACTS[id];
              return (
                <li key={id} aria-labelledby={`sdk-${id}`} className="flex flex-col gap-3 rounded-xl border border-line bg-paper p-5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 id={`sdk-${id}`} className="text-lg font-bold" dir="ltr">{f.name}</h3>
                    <span className={`pill shrink-0 text-xs ${sdkPublished(id) ? "border-accent bg-accent text-paper" : "border-warn/50 bg-warn-soft text-warn"}`}>{sdkPublished(id) ? f.registry : t.sdks.labels.notPublished}</span>
                  </div>
                  <dl className="space-y-2 text-sm">
                    <div><dt className="text-ink-3">{t.sdks.labels.pkg}</dt><dd><C>{f.pkg}</C></dd></div>
                    <div><dt className="text-ink-3">{t.sdks.labels.runsOn}</dt><dd className="text-ink-2">{card.runsOn}</dd></div>
                    <div><dt className="text-ink-3">{t.sdks.labels.status}</dt><dd className="text-ink-2">{sdkStatus(lang, id)}</dd></div>
                  </dl>
                  <div className="text-sm">
                    <h4 className="font-medium">{t.sdks.labels.does}</h4>
                    <ul className="mt-1 space-y-1 text-ink-2">{card.does.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className="text-accent">✓</span>{x}</li>)}</ul>
                  </div>
                  <div className="text-sm">
                    <h4 className="font-medium">{t.sdks.labels.notYet}</h4>
                    <ul className="mt-1 space-y-1 text-ink-3">{card.notYet.map((x) => <li key={x} className="flex gap-2"><span aria-hidden>–</span>{x}</li>)}</ul>
                  </div>
                  <a href={`#code-${id}`} className="mt-auto text-sm font-medium text-accent-ink underline">{t.sdks.labels.code}</a>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section id="quickstart" title={s.quickstart} lead={t.quickstart.lead}>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {t.quickstart.steps.map((st, i) => (
              <li key={st.title} className="card">
                <span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-2 font-bold">{st.title}</h3>
                <p className="mt-2 text-sm text-ink-2">{st.body}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="code" title={s.code} lead={t.code.lead} tinted>
          <div className="space-y-3">
            {SDK_IDS.map((id, i) => (
              <details key={id} id={`code-${id}`} open={i === 0} className="scroll-mt-20 rounded-xl border border-line bg-paper">
                <summary className="cursor-pointer px-5 py-4 font-bold" dir="ltr">{SDK_FACTS[id].name}</summary>
                <div className="space-y-4 px-5 pb-5">
                  {SNIPPET_KEYS.map((k) => (
                    <div key={k}>
                      <h3 className="mb-2 text-sm font-medium text-ink-2">{t.code.snippets[k]}</h3>
                      <Code code={SDK_SNIPPETS[id][k]} label={`${SDK_FACTS[id].name}: ${t.code.snippets[k]}`} />
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </Section>

        <Section id="events" title={s.events} lead={t.events.lead}>
          <Bullets items={t.events.rules} />
          <h3 className="mt-8 font-bold">{t.events.examplesTitle}</h3>
          <ul className="mt-3 max-w-3xl divide-y divide-line rounded-xl border border-line bg-card">
            {EXAMPLE_EVENTS.map((name) => (
              <li key={name} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2.5">
                <C>{name}</C><span className="text-sm text-ink-2">{t.events.examples[name]}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="identity" title={s.identity} lead={t.identity.lead} tinted>
          <Bullets items={t.identity.points} />
        </Section>

        <Section id="consent" title={s.consent} lead={t.consent.lead}>
          <h3 className="font-bold">{t.consent.purposesTitle}</h3>
          <ul className="mt-3 max-w-3xl divide-y divide-line rounded-xl border border-line bg-card">
            {PURPOSES.map((p) => (
              <li key={p} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[120px_1fr]"><C>{p}</C><span className="text-sm text-ink-2">{t.consent.purposes[p]}</span></li>
            ))}
          </ul>
          <div className="mt-6"><Bullets items={t.consent.points} /></div>
        </Section>

        <Section id="delivery" title={s.delivery} lead={t.delivery.lead} tinted>
          <dl className="max-w-3xl divide-y divide-line rounded-xl border border-line bg-paper">
            {t.delivery.rows.map((r) => (
              <div key={r.topic} className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_1fr]">
                <dt className="font-medium">{r.topic}</dt><dd className="text-sm text-ink-2">{r.value}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="testing" title={s.testing} lead={t.testing.lead}>
          <ol className="max-w-3xl space-y-3">
            {t.testing.steps.map((x, i) => (
              <li key={x} className="flex gap-3 text-ink-2"><span className="font-mono text-sm text-accent-ink">{String(i + 1).padStart(2, "0")}</span><span>{x}</span></li>
            ))}
          </ol>
        </Section>

        <Section id="deep-links" title={s["deep-links"]} lead={t.deepLinks.lead} tinted>
          <Bullets items={t.deepLinks.points} />
        </Section>

        <Section id="server" title={s.server} lead={t.server.lead}>
          <Bullets items={t.server.points} />
          <div className="mt-6 max-w-3xl"><Code code={SERVER_SNIPPET} label="REST API" /></div>
        </Section>

        <Section id="notes" title={s.notes} tinted>
          <ul className="grid gap-4 md:grid-cols-2">
            {t.notes.items.map((n) => (
              <li key={n.title} className="rounded-xl border border-line bg-paper p-5">
                <h3 className="font-bold">{n.title}</h3>
                <p className="mt-1 text-sm text-ink-2">{n.body}</p>
              </li>
            ))}
          </ul>
        </Section>

        <section className="mx-auto max-w-5xl px-4 py-14">
          <div className="rounded-2xl bg-ink px-6 py-10 text-paper md:px-12">
            <h2 className="text-2xl font-bold md:text-3xl">{t.cta.title}</h2>
            <p className="mt-2 text-paper/80">{t.cta.lead}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href={start} className="inline-flex min-h-10 items-center rounded-lg bg-paper px-4 text-sm font-medium text-ink hover:bg-paper-2">{closed ? t.nav.requestAccess : t.cta.start}</Link>
              <a href={`mailto:${CONTACT_EMAIL}?subject=LeanApp%20SDK`} className="inline-flex min-h-10 items-center rounded-lg border border-paper/40 px-4 text-sm font-medium text-paper hover:bg-paper/10">{t.cta.contact}</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap justify-between gap-2 px-4 py-6 text-sm text-ink-3">
          <span>© {new Date().getFullYear()} {t.footer.rights} · leanapp.io · <Link href={`/?lang=${lang}`} className="underline">{t.footer.home}</Link></span>
          <span>{t.footer.contact}: <a href={`mailto:${CONTACT_EMAIL}`} className="underline" dir="ltr">{CONTACT_EMAIL}</a></span>
        </div>
      </footer>
    </div>
  );
}
