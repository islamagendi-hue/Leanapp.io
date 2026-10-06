# Naming and positioning

**Decision:** the owner chose **LeanApp** with the domain **leanapp.io** (2026-10-05). Everything in the code uses it: key prefixes `la_pk_` / `la_sk_`, package `@leanapp/analytics`, hosts `app.leanapp.io` and `api.leanapp.io`. Trademark search in the target markets (GCC, Egypt, Jordan) is still to be done by the owner.

## Positioning

> **One SDK for mobile growth.** Attribution, analytics and automation on one event stream, starting from your business model, built for apps in MENA.

- **For** growth and product teams at MENA mobile apps (delivery, commerce, fintech, subscriptions).
- **Against** the three-tool stack (MMP + analytics + messaging) with three SDKs and a spreadsheet tracking plan.
- **Proof** the Implementation Score: you can see whether your tracking matches your business before trusting the numbers.
- **Local edge** SAR/AED and regional currencies, TikTok and Snapchat as first-class channels, Arabic-first, regional data residency on request.

## Names explored

Criteria: short, easy to say in Arabic and English, no clash with large analytics brands, works as an SDK namespace, .io/.com plausibility (availability was not checked; nothing was bought).

| # | Name | Note |
| --- | --- | --- |
| 1 | **LeanApp** | Chosen. Plain, says "efficient growth for apps", easy in Arabic (لين آب) |
| 2 | AppLoop | Growth-loop idea; generic, likely taken |
| 3 | Growlytics | Descriptive, crowded "-lytics" space |
| 4 | Tracksmith | Emphasises implementation; possible clash, check |
| 5 | Signalix | Data-signal angle |
| 6 | Mawj (موج, wave) | Arabic, memorable; harder for global buyers |
| 7 | Nabd (نبض, pulse) | Arabic "pulse"; likely in use, check |
| 8 | Sahm (سهم, arrow/share) | Short; finance connotation |
| 9 | Raqam (رقم, number) | Data angle; generic |
| 10 | Masar (مسار, path) | Journey angle; common word |
| 11 | Wasl (وصل, connection) | Attribution angle |
| 12 | Athar (أثر, trace/impact) | Attribution angle; elegant, less known pronunciation |
| 13 | Funnelio | Too narrow |
| 14 | Cohorta | Analytics only |
| 15 | Eventra | Event-stream angle |
| 16 | Stackless | "Replace your stack"; abstract |
| 17 | Pulsewise | Engagement angle |
| 18 | Kinetiq | Momentum; spelling friction |
| 19 | Launchpad Data | Long |
| 20 | Pathwise | Journey analytics |
| 21 | Attribly | Attribution only |
| 22 | Tracewell | Implementation quality |
| 23 | Groundtruth | Data trust; likely in use in ad tech, check |
| 24 | Halo Growth | Generic |
| 25 | Retain.io | Retention only |
| 26 | Uplift Mobile | Generic |
| 27 | Sabeel (سبيل, way) | Arabic; religious connotations |
| 28 | Qimma (قمة, summit) | Arabic; aspirational |
| 29 | Mizan (ميزان, balance/scale) | Measurement angle; common in finance names |
| 30 | Bawsala (بوصلة, compass) | Guidance angle; long |
| 31 | Northstar Mobile | Tied to one metric concept |
| 32 | Loopwise | Growth loops |

## Landing page

`apps/platform/src/app/page.tsx`: hero "One SDK for mobile growth", the five-step loop, three differentiators, and a product-status table that states what is live, in development and planned.
