#!/usr/bin/env bash
# Refuses a release whose deploy prerequisites are missing. Run by
# .github/workflows/deploy.yml BEFORE migrations, so a database is never
# migrated for a release that cannot be deployed and smoke tested.
#
#   DEPLOY_TARGET=production DATABASE_URL=... CRON_SECRET=... APP_URL=... \
#   VERCEL_DEPLOY_HOOK_URL=... WORKER_SCHEDULE='*/5 * * * *' \
#     bash scripts/ci/check-deploy-config.sh
#
# Prints only the NAMES of missing or malformed settings, never their values.
# Exit codes: 0 ok, 1 missing/malformed settings, 2 bad DEPLOY_TARGET.
#
# Production requires everything, including the Vercel deploy hook and APP_URL
# (the smoke test URL): without them the code would not be deployed or not be
# smoke tested after its migrations ran. Staging may run without the deploy hook
# (until the Vercel project exists); the workflow then warns and skips deploy
# and smoke test.
set -u

target="${DEPLOY_TARGET:-}"
case "$target" in
  production | staging) ;;
  *)
    echo "::error::DEPLOY_TARGET must be 'production' or 'staging'."
    exit 2
    ;;
esac

missing=""
malformed=""

need() { # need NAME: the variable must be set and non-empty
  [ -n "${!1:-}" ] || missing="$missing $1"
}
https_url() { # https_url NAME: when set, the value must be an https:// URL
  local v="${!1:-}"
  if [ -n "$v" ] && [[ "$v" != https://* ]]; then malformed="$malformed $1(must start with https://)"; fi
}

need DATABASE_URL
need CRON_SECRET
need APP_URL
need WORKER_SCHEDULE
if [ "$target" = production ]; then
  need VERCEL_DEPLOY_HOOK_URL
fi

db="${DATABASE_URL:-}"
if [ -n "$db" ] && [[ "$db" != postgres://* && "$db" != postgresql://* ]]; then
  malformed="$malformed DATABASE_URL(must start with postgres:// or postgresql://)"
fi
https_url APP_URL
https_url VERCEL_DEPLOY_HOOK_URL

if [ -n "$missing" ] || [ -n "$malformed" ]; then
  [ -z "$missing" ] || echo "::error::Missing in the GitHub environment '$target':$missing"
  [ -z "$malformed" ] || echo "::error::Malformed in the GitHub environment '$target':$malformed"
  echo "::error::Refusing to migrate or deploy. Set them under Settings -> Environments -> $target (docs/ops/deploy-and-branch-protection.md)."
  exit 1
fi

if [ "$target" = staging ] && [ -z "${VERCEL_DEPLOY_HOOK_URL:-}" ]; then
  echo "::warning::VERCEL_DEPLOY_HOOK_URL is not set for staging; migrations will run but no deployment or smoke test will."
fi
echo "Deploy configuration for '$target' is complete."
