# LeanApp brand guidelines

Version 1.0 · October 2026 · Owner: Islam Gendi

This guide describes how LeanApp looks, sounds and reads in English and Arabic. It is built on the styles already in the product (`apps/platform/src/app/globals.css`, `layout.tsx`, `icon.svg`), so the dashboard is the reference implementation. Where the code and this guide disagree, section 11 lists the fixes.

---

## 1. Brand essence

| | |
| --- | --- |
| **Name** | LeanApp · لين آب |
| **Category line** | The growth infrastructure for mobile apps · البنية التحتية لنمو تطبيقات الجوال |
| **Headline** | One SDK for mobile growth. · حزمة SDK واحدة لنمو تطبيقات الجوال. |
| **Who it is for** | Growth and product teams at small and mid-size app companies in Egypt, the Gulf and the wider Arabic-speaking market: delivery, commerce, fintech, subscriptions, super apps. |
| **What it replaces** | The three-tool stack (MMP + analytics + messaging) with three SDKs and a tracking plan in a spreadsheet. |
| **Promise** | Attribution, analytics and automation on one event stream, starting from your business model, and you can see whether the data is right before you rely on it. |

### Brand pillars

1. **Starts from your business.** The tracking plan comes from a questionnaire about how the business makes money, not from a generic event list.
2. **Data you can trust.** Every event is checked against the plan and the Implementation Score shows what is missing. We show the work.
3. **One stream, one SDK.** Attribution, analytics and automation share the same events. Fewer tools, less glue.
4. **Built for the region.** Arabic-first interfaces, SAR/AED/EGP and other regional currencies, TikTok and Snapchat as first-class channels, regional data residency on request.

### Personality

Precise, calm, plain-spoken, useful. LeanApp sounds like a senior growth engineer who has set this up many times: direct about what works today and what does not yet.

---

## 2. Name

- Write **LeanApp**: one word, capital L, capital A.
- In Arabic write **لين آب** (two words, with the madda on آ). Do not transliterate it differently (لين اب, ليناب).
- The domain is always lowercase: **leanapp.io**. Hosts: `app.leanapp.io` (dashboard), `api.leanapp.io` (API).
- The SDK package is `@leanapp/analytics`. Key prefixes are `la_pk_` (publishable) and `la_sk_` (secret).
- Never: Leanapp, Lean App, LEANAPP, Lean-App, leanApp, LA (as a standalone short name).
- LeanApp is a name, not a verb. Write "track it with LeanApp", not "LeanApp it".

---

## 3. Logo

### The mark

The mark is a rounded square with an **L** drawn as one continuous stroke (the "lean" baseline) and a **signal dot** at the top right: an event arriving. Source: `apps/platform/src/app/icon.svg`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0e1311"/>
  <path d="M10 8v16h12" fill="none" stroke="#f4f2ec" stroke-width="3.5"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="22" cy="10" r="3" fill="#2fa37a"/>
</svg>
```

Construction on a 32-unit grid: corner radius 7, stroke 3.5 with round caps and joins, the L runs from (10, 8) to (10, 24) to (22, 24), the dot is centred at (22, 10) with radius 3.

### Wordmark and lockups

- **Wordmark:** "LeanApp" set in Dubai Bold, tracking −1%. Do not redraw or stretch it.
- **Horizontal lockup:** mark + wordmark, mark height = 1.6 × the wordmark's cap height, gap = 0.5 × mark height. This is the default.
- **Arabic lockup:** mark + "لين آب" in Dubai Bold. In RTL layouts the mark sits on the right (start) of the Arabic wordmark. The mark itself never mirrors.
- **Bilingual lockup** (signage, decks): mark, then "LeanApp" and "لين آب" stacked, Latin on top.

### Clear space and size

- Clear space on every side = 6 units on the 32-unit grid, about 20% of the mark's height, around the mark and around any lockup.
- Minimum size: 16 px for the mark alone (favicon), 24 px mark height for a lockup on screen, 8 mm in print.

### Colour versions

| Version | Tile | L stroke | Dot | Use |
| --- | --- | --- | --- | --- |
| Primary | Ink `#0e1311` | Paper `#f4f2ec` | Signal `#2fa37a` | Default, light and dark backgrounds |
| Reversed | Paper `#f4f2ec` | Ink `#0e1311` | Green `#0f6b4f` | On ink or photography |
| One colour | none | Ink or paper | same as stroke | Embossing, fax, single-colour print |

### Do not

- Recolour the tile or dot outside the versions above, or add gradients, shadows or outlines.
- Mirror the mark in RTL layouts, rotate it or change its proportions.
- Put the dot on the left, replace it with another shape, or animate it in a way that changes the shape at rest.
- Set the wordmark in another typeface or in all caps.
- Place the primary mark on busy photography without the reversed tile.

---

## 4. Colour

The palette is warm paper and deep ink with one green accent. Green means action and success. Colour is rare and earns its place: most screens are paper, ink and lines.

### Core palette (light, as shipped)

| Token | Hex | Role | Contrast |
| --- | --- | --- | --- |
| `paper` | `#f4f2ec` | Page background | — |
| `paper-2` | `#ebe8e0` | Hover fills, sunken areas | — |
| `card` | `#fbfaf7` | Cards, panels, table bodies | — |
| `ink` | `#0e1311` | Primary text, primary buttons, code blocks | 16.8:1 on paper |
| `ink-2` | `#3b413e` | Secondary text, descriptions | 9.3:1 on paper |
| `ink-3` | `#6a706c` | Captions, placeholders, table headers | 4.5:1 on paper |
| `line` | `#d8d4ca` | Borders, dividers | — |
| `line-strong` | `#b9b4a8` | Input and secondary-button borders | — |
| `accent` | `#0f6b4f` | Links, focus rings, selection, "live" state | 5.8:1 on paper |
| `accent-ink` | `#0a4c38` | Green text on paper or on `accent-soft` | 8.9:1 on paper |
| `accent-soft` | `#dcebe3` | Success backgrounds | — |
| `signal` | `#2fa37a` | Logo dot, live indicators on ink. Not for text on paper | 5.8:1 on ink |

### Status colours

| Token | Hex | Soft | Meaning |
| --- | --- | --- | --- |
| `accent` | `#0f6b4f` | `#dcebe3` | Success, live, valid |
| `warn` | `#8a6a12` → **`#7a5c0e`** | `#f5ecd2` | Building, needs attention, partial |
| `alert` | `#a8492a` | `#f4e2da` | Error, destructive, invalid |

`warn` on `warn-soft` is 4.3:1 today, just under WCAG AA for small text. Use `#7a5c0e` (5.3:1) for warn text; see section 11.

Status is never shown by colour alone: pair it with a label ("Live", "Building", "Planned") or an icon.

### Proportions

Roughly 70% paper/card, 20% ink (text, primary buttons, code), 8% lines and greys, 2% green. One primary (ink) button per view; green is for links, focus, state and the logo dot, not large fills.

### Chart palette

Series colours, in order (from `TrendChart.tsx`): green `#0f6b4f`, clay `#a8492a`, blue `#3d5a99`, ochre `#8a6a12`, plum `#7a3e8c`, grey `#6a706c`. All reach 4.5:1 or more on paper. Gridlines use `line`, axis labels use `ink-3`. Keep the first series for the metric the page is about.

### Dark theme (proposal, not built yet)

| Token | Light | Dark |
| --- | --- | --- |
| `paper` | `#f4f2ec` | `#0e1311` |
| `paper-2` | `#ebe8e0` | `#131916` |
| `card` | `#fbfaf7` | `#161c19` |
| `ink` | `#0e1311` | `#f4f2ec` |
| `ink-2` | `#3b413e` | `#c4c7c2` |
| `ink-3` | `#6a706c` | `#959b96` |
| `line` | `#d8d4ca` | `#2a312d` |
| `line-strong` | `#b9b4a8` | `#3c443f` |
| `accent` | `#0f6b4f` | `#3fb58a` |
| `accent-ink` | `#0a4c38` | `#6fd0a9` |
| `accent-soft` | `#dcebe3` | `#15392c` |
| `warn` | `#7a5c0e` | `#d4a73a` |
| `alert` | `#a8492a` | `#e07a55` |

In dark, the primary button flips to paper on ink (`bg-ink text-paper` still works because the tokens swap). The logo stays the primary version.

---

## 5. Typography

### Typefaces

| Role | Face | Weights | Why |
| --- | --- | --- | --- |
| Everything (Latin and Arabic) | **Dubai** | Light 300, Regular 400, Medium 500, Bold 700 | One family that covers both scripts with matching rhythm, designed for screens, widely recognised in the Gulf. Shipped in `apps/platform/src/app/fonts/`. |
| Code, ids, keys, event names, data labels | **IBM Plex Mono** | Regular 400, Medium 500 | Clear distinction between 0/O and 1/l, good for keys like `la_pk_…`. Latin only. |

Fallback stack: `Dubai, "Noto Sans Arabic", "Segoe UI", ui-sans-serif, system-ui, sans-serif`.

### Scale (as used in the product)

| Style | Size / line height | Weight | Class |
| --- | --- | --- | --- |
| Display (marketing hero) | 60 / 1.1 desktop, 36 / 1.15 mobile | Bold | `text-4xl md:text-6xl font-bold` |
| Page title | 30 / 1.2 desktop, 24 mobile | Bold, tracking −1% | `.h1` |
| Section title | 18 / 1.4 | Bold | `.h2` |
| Lead | 18 / 1.55 | Regular | `text-lg text-ink-2` |
| Body | 15–16 / 1.55 | Regular | base, inputs at 15 |
| Small | 14 / 1.5 | Regular or Medium | `text-sm` |
| Caption | 12 / 1.4 | Regular | `.help` |
| Eyebrow / table header | 11–12, uppercase, tracking 0.05–0.1em | Plex Mono Medium | `font-mono text-[11px] uppercase tracking-wide` |
| Code | 12.5 / 1.6 | Plex Mono Regular | `.code` |

### Rules

- Bold (700) for titles, Medium (500) for labels and emphasis, Regular for running text. Light (300) only at display sizes.
- Keep running text to about 65 characters (`max-w-2xl`).
- Use tabular numbers (`tabular-nums`) in tables, counters and charts.
- **Arabic:** never uppercase or letter-space Arabic (it breaks letter joining). Raise line height to 1.7 for Arabic body text. Arabic eyebrows use Dubai Medium at 13 px instead of Plex Mono, which has no Arabic glyphs.
- Do not use italics in Arabic; use Medium weight for emphasis in both scripts.

---

## 6. Bilingual and RTL

LeanApp is bilingual by design. Arabic is a first-class language, not a translation layer.

### Layout

- Set `lang` and `dir` on `<html>`: `lang="ar" dir="rtl"` or `lang="en" dir="ltr"`.
- Use logical properties everywhere: `ms-*/me-*`, `ps-*/pe-*`, `start-*/end-*`, `text-start/text-end`, `border-s/border-e`, `rounded-s/rounded-e`. Avoid `left/right`, `ml/mr`, `pl/pr`, `text-left`.
- The whole layout mirrors in RTL: navigation, sidebars, form labels, breadcrumbs, progress steps, table column order.

### What mirrors and what does not

| Mirror in RTL | Never mirror |
| --- | --- |
| Back/forward arrows, chevrons, "next step" icons | The LeanApp logo |
| Sidebar and drawer position | Code, API keys, event names, URLs |
| Progress bars and step lists | Media playback controls |
| Icons that show direction of reading (list indent, reply) | Checkmarks, clocks, charts' time axes |

Charts keep time running left to right in both languages; put the legend and axis titles in the reading direction.

### Numbers, dates and money

- Use Western digits (0–9) in the product by default, in both languages. They are standard in dashboards across Egypt and the Gulf and keep tables comparable. Offer Eastern Arabic digits (٠–٩) as a locale option later for marketing copy if research supports it.
- Format with `Intl.NumberFormat` and `Intl.DateTimeFormat` using `ar-EG`, `ar-SA`, `ar-AE` or `en` and `numberingSystem: "latn"`.
- Currency: show the ISO code in data views (`SAR 1,250.00`, `EGP 980`) and the local symbol in marketing (`1,250 ر.س`). Never convert currencies silently.
- Dates in tables: `2026-10-05` (ISO) or `5 Oct 2026` / `٥ أكتوبر ٢٠٢٦` in prose. The week starts on Saturday or Sunday depending on the market; let the org choose.

### Mixed-direction text

- Wrap Latin tokens inside Arabic sentences (keys, event names, SDK, code) in `<bdi>` or `dir="ltr"` spans so punctuation lands on the right side.
- Keep technical terms in Latin script inside Arabic copy: SDK, API, iOS, Android, `purchase_completed`. Do not transliterate them.
- Inputs that take code, emails, URLs or keys are `dir="ltr"` even in the Arabic UI.

---

## 7. Voice and tone

### Principles

1. **Plain over clever.** Say what it does. "Send your first event" beats "Ignite your growth journey".
2. **Specific over vague.** Name the event, the number and the next step.
3. **Honest about status.** The product status table (Live / Building / Planned) is part of the brand. Never present planned features as available.
4. **Show the reason.** Every generated event comes with why it exists. Explain decisions the same way in copy.
5. **Calm in errors.** Say what happened and how to fix it. No apologies, no blame, no exclamation marks.

### Examples

| Do | Don't |
| --- | --- |
| Your plan has 14 events. 3 are not arriving yet. | Oops! Something's not quite right with your tracking 😅 |
| Attribution is planned. Click ids are captured now so past installs can be matched later. | Revolutionary AI-powered attribution coming soon! |
| This key can send events but cannot read data. | Super-secure next-gen key technology. |
| Invalid property `price`: expected a number, got "12 SAR". | Error 400. |

### Arabic voice

- Modern Standard Arabic that reads naturally to Egyptian and Gulf readers. Avoid dialect in the product; dialect is fine in social posts aimed at one market.
- Write Arabic copy from the meaning, not word by word from English. Short sentences, active voice.
- Address the reader in the plural/neutral form (أضف، أرسل) in the UI.
- Have every Arabic string reviewed by a native speaker before launch.

### Glossary

| English | Arabic | Note |
| --- | --- | --- |
| Growth infrastructure | البنية التحتية للنمو | |
| Attribution | الإسناد | "إسناد التثبيتات" when talking about installs |
| Analytics | التحليلات | |
| Automation | الأتمتة | |
| Event | حدث (أحداث) | Event names stay in Latin |
| Tracking plan | خطة التتبع | |
| Implementation Score | درجة جودة التنفيذ | |
| Funnel | مسار التحويل | |
| Retention | الاحتفاظ بالمستخدمين | |
| Cohort | شريحة | |
| Audience | جمهور | |
| Dashboard | لوحة التحكم | |
| Environment (dev / staging / prod) | بيئة (تطوير / اختبار / إنتاج) | |
| Organisation | مؤسسة | |
| Publishable key / Secret key | مفتاح عام / مفتاح سري | |

---

## 8. Interface components

The product's component classes live in `globals.css`. Follow them in new screens and in marketing.

| Element | Spec |
| --- | --- |
| Primary button `.btn` | Ink fill, paper text, 40 px min height, radius 8, 14 px Medium. One per view. |
| Secondary button `.btn-secondary` | Card fill, `line-strong` border, ink text. |
| Danger button `.btn-danger` | Alert text, alert border at 40%, alert-soft hover. Destructive actions only. |
| Input `.input` | White fill, `line-strong` border, radius 8, 40 px, 15 px text, green border on focus. |
| Card `.card` | Card fill, `line` border, radius 12, 20 px padding, no shadow. |
| Pill `.pill` | Full radius, 1 px border, Plex Mono 11 px uppercase. Live = green fill, Building = warn outline, Planned = line outline. |
| Code `.code` | Ink background, paper text, Plex Mono 12.5, radius 8. |
| Table `.table` | Mono uppercase headers in `ink-3`, `line` dividers, no zebra stripes. |
| Focus | 2 px green outline, 2 px offset, on every interactive element. |

Shape: radius 8 for controls, 12 for cards, full for pills; no drop shadows. Spacing follows the 4 px Tailwind scale; sections use 56–80 px vertical padding. Touch targets are at least 40 px.

---

## 9. Iconography, imagery and data visuals

- **Icons:** line icons at 1.5–2 px stroke with round caps and joins, matching the L in the mark (Lucide fits). 20 px in UI, 16 px inline.
- **Imagery:** real product screens with realistic regional data (Arabic app names, SAR and EGP amounts, Riyadh/Cairo/Dubai cities). No stock photos of people pointing at screens, no 3D blobs.
- **Data visuals:** thin lines (2 px), faint `line` gridlines, emphasised last point, direct labels where possible. Colour comes from the chart palette in section 4.
- **Motif:** the signal dot. Use it sparingly as a live indicator (a pulsing green dot next to "Live"), never as decoration on every heading.

---

## 10. Applications

- **Favicon and app icon:** primary mark on its tile. Already shipped as `icon.svg`.
- **Social avatar:** primary mark, tile filling the frame.
- **Open Graph image (1200×630):** paper background, lockup top-start, headline in Dubai Bold 64 px, eyebrow in Plex Mono, one product screenshot.
- **Email (Resend):** paper background, card body, wordmark header, ink button. Plain text version always included.
- **Decks:** paper slides, ink type, one green highlight per slide, bilingual title slide.
- **Social posts:** one message per post, Arabic and English versions as separate posts rather than both on one image.

---

## 11. Gaps between this guide and the code

These are notes for the build, not changes made by this document.

1. `icon.svg` uses `#151515` for the tile instead of `ink` `#0e1311`, and its dot `#2fa37a` is not a token. Align the tile to `ink` and add `--color-signal: #2fa37a`.
2. `--color-warn` `#8a6a12` on `warn-soft` is 4.3:1. Change it to `#7a5c0e`.
3. `layout.tsx` hardcodes `lang="en"` with no `dir`. RTL needs `lang`/`dir` from the user's locale.
4. `.table th` uses `text-left`; it should be `text-start`. Check other `left/right`, `ml/mr`, `pl/pr` utilities for logical equivalents.
5. The landing page header shows "LeanApp" as plain text. Use the lockup.
6. `globals.css` notes that the palette and Dubai font are shared with the Growx Era site. LeanApp is a separate brand: keep the tokens in LeanApp's own file and let them diverge when needed.
7. No dark theme yet. Section 4 has the proposed tokens.
8. Trademark search for "LeanApp" in the GCC, Egypt and Jordan is still open (see `docs/naming.md`).
