# Deploy safety and branch protection

How a commit is allowed to reach staging or production, what the Deploy
workflow needs, and the branch protection the **owner** must turn on in GitHub.
The full runbook is [deployment](../deployment.md).

Status (2026-10-09):

- **Built:** the Deploy workflow only runs after CI passed on the same commit,
  checks its configuration before migrations, and always smoke tests production.
- **Not enabled:** branch protection. On this date
  `gh api repos/islamagendi-hue/leanapp.io/branches/main/protection` answered
  `404 Branch not protected`, and `gh api repos/islamagendi-hue/leanapp.io/rulesets`
  answered `[]`. Nothing in the repository can turn it on: there is no settings
  app file or ruleset file, and protection is a repository setting. It is an
  owner action (below). Do not treat it as on until the evidence step passes.

## How the Deploy workflow is gated

`.github/workflows/deploy.yml` is triggered by `workflow_run` of the **CI**
workflow (`.github/workflows/ci.yml`), not by the push itself:

1. A push to `main` or `staging` runs CI (CI runs on pushes to both branches and on every pull request).
2. When CI completes, Deploy starts. Its job runs only when
   - the CI conclusion is `success`,
   - the CI run was for a `push` (never a pull request),
   - the pushed branch is in this repository and is `main` (environment `production`) or `staging` (environment `staging`).
3. Deploy checks out `github.event.workflow_run.head_sha`, the exact commit CI tested.
4. `apps/platform/scripts/ci/check-deploy-config.sh` refuses the run when a
   required secret or variable is missing or malformed. This is **before**
   `npm ci` and migrations, so no migration runs for a release that cannot be
   deployed and smoke tested.
5. The run refuses if the branch has moved past that commit (the deploy hook
   builds the branch head, so it must be the tested commit). Checked before
   migrations and again just before the deploy hook. The newer commit's own run
   deploys it.
6. Migrations, pg_cron schedule, Vercel deploy hook, smoke test.

There is **no manual trigger** (`workflow_dispatch` was removed). A manual run
could have deployed a commit that CI never passed; verifying that would need
extra API permissions and code, while removing it is smaller and safe. To retry
a failed deploy, open the failed Deploy run and use **Re-run jobs**: it re-runs
for the same commit and the same CI result. To deploy again after a fix, push
(or merge) to the branch.

Notes:

- `workflow_run` always runs `deploy.yml` **as it is on `main`**. A change to
  `deploy.yml` on `staging` has no effect until it is merged to `main`.
- In a `workflow_run` job `github.ref` is `main`. A GitHub environment
  "deployment branches" rule restricted to `staging` would therefore refuse
  staging runs: leave the `staging` environment unrestricted (or "All
  branches"). Restricting `production` to `main` still works, but the real
  branch check is the job's `if:` on `head_branch`.
- The smoke test cannot be skipped in production: the deploy hook is required
  there, so the smoke step always runs after it. In staging, a missing hook
  skips deploy and smoke test with a warning (migrations still run, as before).
- `apps/platform/scripts/ci/check-deploy-config.test.ts` (unit project, runs in
  CI) runs the check script with missing, empty, malformed and complete
  settings and asserts the exit codes and that no value is printed. It also
  parses all workflow files (with PyYAML when present; GitHub's Ubuntu runners
  have it) and asserts the gating above: `workflow_run` on CI only, the
  `success`/`push` condition, checkout of `head_sha`, the check step before
  `db:migrate`, and the production smoke test.

## Secrets and variables the Deploy job needs

Set per environment under **Settings → Environments → `production` / `staging`**.
Names only; values never go in the repository or in logs (the check script
prints names, never values).

| Name | Kind | Production | Staging | When missing |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | secret | required | required | Run refused before migrations: `Missing in the GitHub environment ...: DATABASE_URL`. Also refused when it does not start with `postgres://` or `postgresql://`. |
| `CRON_SECRET` | secret | required | required | Run refused before migrations. |
| `APP_URL` | secret | required | required | Run refused before migrations. It is the smoke test URL; must start with `https://`. |
| `VERCEL_DEPLOY_HOOK_URL` | secret | required | optional | Production: run refused before migrations (and the deploy step fails again if it were somehow empty). Staging: warning; migrations and schedule run, no deployment and no smoke test. Must start with `https://`. |
| `WORKER_SCHEDULE` | variable | required | required | Run refused before migrations. `*/5 * * * *` production, `*/15 * * * *` staging. |
| `VERCEL_BYPASS` | secret | not used | optional | Only needed when the staging deployment is behind Vercel Authentication; without it the smoke test there gets 401 and fails. |
| `SMOKE_SDK_KEY` | secret | optional | optional | The smoke test skips its test-event check (health, worker endpoint and pg_cron checks still run and are required). Kept optional because the internal smoke app can only be created after the first deploy. |

## Branch protection (owner action)

Required for `main` (production). Recommended for `staging` too, with the same
rules, so nothing reaches staging that CI has not seen either.

Rules:

| Rule | Setting |
| --- | --- |
| Require a pull request before merging | on (required approvals: 0 for a solo owner, 1 once there is a second maintainer) |
| Require status checks to pass | on |
| Required checks (exact CI job names) | `Platform and SDK`, `Android SDK`, `iOS SDK`, `Flutter SDK` |
| Require branches to be up to date before merging | on |
| Block force pushes | on |
| Restrict deletions | on |
| Apply to administrators (do not allow bypass) | on, so the owner cannot push to `main` by accident either |

The four check names are the `name:` of the jobs in `.github/workflows/ci.yml`
(job ids `platform`, `sdk-android`, `sdk-ios`, `sdk-flutter`). If a job is
renamed there, the required check must be renamed here and in GitHub, or every
pull request waits forever for a check that no longer exists. The Deploy and
SDK release dry-run workflows are not pull request checks and must not be
required. GitHub only offers a check in the search box after it has run once in
the repository (CI runs on every pull request, so open one first if the list is
empty).

### Steps in the GitHub UI (ruleset, recommended)

1. Repository **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.
2. Name `protect main and staging`, **Enforcement status: Active**.
3. **Bypass list:** leave empty.
4. **Target branches → Add target → Include by pattern:** `main`; again for `staging`.
5. Tick:
   - **Restrict deletions**
   - **Require a pull request before merging** (required approvals 0 or 1, see above)
   - **Require status checks to pass** → tick **Require branches to be up to date before merging** → **Add checks**: `Platform and SDK`, `Android SDK`, `iOS SDK`, `Flutter SDK` (source: GitHub Actions)
   - **Block force pushes**
6. **Create**.

Classic alternative: **Settings → Branches → Add classic branch protection
rule**, pattern `main` (then again for `staging`): *Require a pull request
before merging*, *Require status checks to pass before merging* with *Require
branches to be up to date* and the four checks above, *Do not allow bypassing
the above settings*; leave *Allow force pushes* and *Allow deletions* off.

### Evidence that it is on

Any one of these, kept with the release notes:

- A screenshot of the ruleset page (Active, targets `main` and `staging`, the four checks listed).
- For a ruleset:
  `gh api repos/islamagendi-hue/leanapp.io/rules/branches/main`
  lists rules of type `deletion`, `non_fast_forward`, `pull_request` and
  `required_status_checks` whose `required_status_checks[].context` are the four
  names above and `strict_required_status_checks_policy` is `true`.
- For a classic rule:
  `gh api repos/islamagendi-hue/leanapp.io/branches/main/protection`
  returns 200 (not `404 Branch not protected`) with
  `required_status_checks.strict: true`, the four `contexts`,
  `allow_force_pushes.enabled: false`, `allow_deletions.enabled: false`,
  `enforce_admins.enabled: true`, and a `required_pull_request_reviews` block.
- On a pull request into `main`, the merge box lists the four checks as
  **Required** and the merge button stays disabled until they pass. (Do not test
  by pushing to `main` directly: if protection is off, that push deploys.)

Repeat with `staging` in place of `main`.
