# ADR-001: Stack and repository layout

**Status:** Accepted · 2026-10-05

## Context
The owner's existing stack (the Growx Era website) is Next.js 16, Tailwind 4, Supabase and Vercel. The brief asks to reuse that stack where sound. LeanApp is a separate product from the website. LeanApp needs a dashboard, an ingestion API and background processing, and will grow into separate services.

## Decision
- LeanApp lives in its own repository (`islamagendi-hue/Leanapp.io`), separate from the Growx Era website. Inside it, the app is `apps/platform` (Next.js 16, own `package.json` and lockfile) and SDKs are under `sdks/`, so more apps and SDKs can be added side by side.
- Use Postgres directly through `pg` (not the Supabase REST client) because the design depends on transactions, `SET LOCAL ROLE` and RLS session settings. Any Postgres works, Supabase included.
- Keep business logic in framework-free modules (`src/modules`) so ingestion and processing can move to a separate service without rewriting.

## Consequences
- One language and one deployment target for phase 1; fast to ship.
- Separate access, history, issues and deploys from the agency website.
- Each package has its own lockfile; moving to npm workspaces later is mechanical.
