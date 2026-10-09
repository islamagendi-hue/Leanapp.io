# LeanApp documentation

LeanApp (leanapp.io) is multi-tenant growth infrastructure for mobile apps. The app is in `apps/platform`, the SDK in `sdks/javascript`.

| Area | Doc |
| --- | --- |
| What and why | [Product requirements](product-requirements.md) · [Naming & positioning](naming.md) · [Roadmap, current state & gaps](roadmap.md) |
| How it is built | [Architecture](architecture.md) · [Database](database.md) · [Multi-tenancy](multi-tenancy.md) · [Security](security.md) · [RBAC](rbac.md) · [Infrastructure](infrastructure.md) · [Deployment](deployment.md) ([deploy safety & branch protection](ops/deploy-and-branch-protection.md)) · [Environments](ops/environments.md) · [Backup & restore](ops/backup-restore.md) · [Monitoring & alerts](ops/monitoring.md) · [SDK release](sdk-release.md) · [Testing](testing.md) |
| Data in | [SDK](sdk.md) · [Events](events.md) · [API](api.md) ([OpenAPI](openapi.yaml)) |
| Implementation intelligence | [Implementation engine](implementation-engine.md) · [Tracking plan](tracking-plan.md) |
| Product modules | [Growth model](growth-model.md) · [Attribution](attribution.md) · [Analytics](analytics.md) · [Audiences](audiences.md) · [Automation](automation.md) · [Experiments (A/B tests)](experiments.md) · [Webhooks](webhooks.md) · [Messaging (WhatsApp, email)](messaging.md) · [Media library](media.md) · [Billing](billing.md) |
| Working on it | [Developer guide](developer-guide.md) · [ADRs](adr/) |

Every LeanApp doc marks what is **built**, what is **partial**, and what is **planned**. If a doc and the code disagree, the code wins and the doc is a bug.
