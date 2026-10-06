# Roadmap, current state and gap analysis

_Last updated 2026-10-05._

## Starting point (before this work)

The owner's only codebase was the Growx Era consultancy website (Next.js 16, Tailwind 4, Supabase REST, Vercel). There was no SaaS code, no multi-tenant schema, no SDK, and no Vercel projects were visible in the connected team. LeanApp was first drafted inside that repo, then moved to its own repository at the owner's request because they are separate products ([ADR-001](adr/ADR-001-stack-and-repo.md)).

## Phase 1: foundation and first-event loop (this PR)

| Area | Status |
| --- | --- |
| Multi-tenant Postgres schema with RLS, 64 tables covering all modules | ✓ |
| Auth (email/password, sessions), organizations, invitations, 5 roles, audit log | ✓ |
| Email verification, password reset and change, session management, invitation emails | ✓ (sending needs `RESEND_API_KEY` and a verified domain) |
| End-user data export and deletion (dashboard and secret-key API) | ✓ |
| Analytics v1: events, funnels, retention (Postgres) | ✓ |
| Organization settings, plan & usage (limits shown, not enforced), audit log viewer | ✓ |
| Scheduled cleanup: plan retention (report by default, `EVENT_RETENTION=enforce` to delete) and operational purges | ✓ |
| Apps with dev/staging/production environments, public and secret keys, rotation, revocation | ✓ |
| Ingestion API (single + batch, idempotent, limits, rate limits, clock skew) | ✓ |
| Processing (identity, sessions, push tokens, plan validation) | ✓ |
| Implementation engine (questionnaire, classifier, generator, versioning, approval, codegen, validation, mappings, score) | ✓ |
| Dashboard: onboarding, questionnaire, plan, SDK & keys, live debugger, validation & mapping, members | ✓ |
| JavaScript / React Native SDK | ✓ (not published to npm) |
| Docs, ADRs, OpenAPI, CI (lint, types, unit, integration, migrations, build, browser end-to-end) | ✓ |
| Production deployment | ✗ waits for owner (database, Vercel project, DNS) |
| Attribution engine (phase 3): tracking links `/l/{code}` with bot/prefetch filtering and rate limits, deterministic install matching (Play referrer, click ids, ad-network click ids), opt-in Android-only probabilistic matching, reinstalls, re-engagement, last-touch conversions and revenue, postback queue with retries, dashboard | ✓ (custom URL postbacks tested; TikTok / Snap / Meta / Google postbacks not verified with the live networks) |

## Gaps to a sellable product

| Gap | Phase | Notes |
| --- | --- | --- |
| Production deployment and monitoring (Sentry or similar, uptime) | 1.5 | Owner decisions in [deployment](deployment.md) |
| Email provider account | 1.5 | Code is built; needs a Resend API key and leanapp.io verified as a sending domain |
| Native SDKs: Android, iOS, Flutter | 2 | API is specified in [SDK](sdk.md) |
| Analytics: cohorts, revenue, user profiles, saved reports | 2 | Events, funnels and retention v1 are built ([analytics](analytics.md)) |
| ClickHouse event store, Redis | 2 | When volume requires ([ADR-002](adr/ADR-002-event-store.md)) |
| Attribution: SKAdNetwork / AdAttributionKit, view-through, cost import / ROAS, MMP import, first-touch and linear models | 3 | Engine, links, matching, conversions, postbacks and dashboard are built ([attribution](attribution.md)) |
| Ad-network postbacks verified live (TikTok, Snap, Meta, Google Ads) | 3 | Request code is built behind encrypted per-postback credentials but untested against the networks: needs a customer's TikTok App ID + Events API token, Snap App ID + CAPI token, Meta dataset ID + system user token, Google Ads customer ID, conversion action, developer token and OAuth client + refresh token. Production also needs `INTEGRATIONS_ENCRYPTION_KEY` and `ATTRIBUTION_IP_HASH_SECRET` |
| Audiences and automation (push, in-app, webhooks) | 3–4 | [Audiences](audiences.md), [Automation](automation.md) |
| Billing provider, limit enforcement | 3 | [Billing](billing.md) |
| OAuth, MFA, SSO | 2–4 | Schema ready |
| Privacy: consent capture and suppression lists | 2 | Export and deletion are built (dashboard and API) |
| LLM-assisted plan suggestions, Arabic free-text classification | 2 | Suggestions only, always approval-gated |
| Plan editing: custom events/properties, version diff, export | 2 | |
| Public management API with secret keys | 2 | |
| Arabic UI | 2 | Layout uses logical properties; strings not yet extracted |

## Phase plan

1. **Phase 1** (PR #1): foundation and first-event loop, plus the production basics pulled forward: email and account security, privacy export and deletion, retention and cleanup jobs, settings, audit log, CSP and structured logs, browser tests, analytics v1.
2. **Phase 1.5**: deploy (waits on the owner's database, Vercel, DNS and email decisions), monitoring, design-partner onboarding (5 MENA apps).
3. **Phase 2**: native SDKs, analytics beyond v1, consent, plan editing, LLM suggestions, Arabic UI.
4. **Phase 3**: attribution with TikTok, Snapchat, Meta, Google; billing.
5. **Phase 4**: audiences and automation.
