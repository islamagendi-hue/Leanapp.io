# LeanApp platform

Multi-tenant growth infrastructure for mobile apps: implementation intelligence, event ingestion, live debugger and (planned) attribution, analytics and automation. Served at leanapp.io (`app.` dashboard, `api.` API) once deployed.

```bash
npm ci
cp .env.example .env.local
npm run db:migrate      # needs a Postgres 15+ DATABASE_URL
npm run dev             # http://localhost:3100
npm test                # unit + integration (DATABASE_URL_TEST is wiped)
```

| Script | Does |
| --- | --- |
| `dev`, `build`, `start` | Next.js on port 3100 |
| `lint`, `typecheck` | ESLint; `next typegen` + `tsc` |
| `test:unit`, `test:integration` | Vitest projects (integration needs Postgres) |
| `db:migrate` | Apply `db/migrations` to `DATABASE_URL` |
| `db:seed-rbac` | Regenerate `0002_rbac_seed.sql` from the permission matrix |

Start with the [developer guide](../../docs/developer-guide.md). All docs: [docs/README.md](../../docs/README.md).
