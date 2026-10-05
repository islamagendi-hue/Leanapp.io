# LeanApp

Growth infrastructure for mobile apps in MENA: one SDK and one event stream for attribution, product analytics and customer automation, starting from an implementation plan designed around your business. leanapp.io.

| Path | What |
| --- | --- |
| [`apps/platform`](apps/platform) | Dashboard, ingestion API, implementation engine (Next.js 16, Postgres) |
| [`sdks/javascript`](sdks/javascript) | `@leanapp/analytics` for JavaScript, TypeScript and React Native |
| [`docs`](docs/README.md) | Product, architecture, security, API ([OpenAPI](docs/openapi.yaml)), ADRs, roadmap |

```bash
cd apps/platform
npm ci
cp .env.example .env.local
npm run db:migrate && npm run dev   # http://localhost:3100
```

What is built and what is planned: [docs/roadmap.md](docs/roadmap.md). Deployment steps: [docs/deployment.md](docs/deployment.md).
