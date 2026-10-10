/**
 * Which Vercel Preview deployments may open a database connection.
 *
 * Staging is a Preview deployment of the `staging` branch, so "no database on
 * previews" would break it. Instead a Preview may connect only when its Git
 * branch (VERCEL_GIT_COMMIT_REF) is in PREVIEW_DB_BRANCHES (comma-separated,
 * default "staging"). Every other Preview (feature branches, CLI deploys
 * without Git metadata) is refused, so a DATABASE_URL accidentally scoped to
 * all of Preview cannot be reached from arbitrary branch deployments.
 *
 * This is a backstop against misconfiguration. The real control is Vercel env
 * scoping (staging secrets on Preview + branch `staging` only), see
 * docs/ops/environments.md. A branch can change this file, so it is no defence
 * against hostile code on a branch.
 *
 * Production and local runs are not affected. Errors never include the URL.
 */
type Env = Record<string, string | undefined>;

export const DEFAULT_PREVIEW_DB_BRANCHES = ["staging"];

export function previewDbBranches(env: Env): string[] {
  const raw = env.PREVIEW_DB_BRANCHES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PREVIEW_DB_BRANCHES;
  return raw
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
}

/** Why this deployment must not use the database, or null when it may. */
export function previewDatabaseBlock(env: Env): string | null {
  if (env.VERCEL_ENV !== "preview") return null;
  const branch = env.VERCEL_GIT_COMMIT_REF?.trim() ?? "";
  const allowed = previewDbBranches(env);
  if (branch && allowed.includes(branch)) return null;
  const list = allowed.length ? allowed.map((b) => JSON.stringify(b)).join(", ") : "no branches";
  return (
    `Database access is disabled on this Preview deployment (branch ${branch ? JSON.stringify(branch) : "unknown"}). ` +
    `Only Preview deployments of ${list} may connect; PREVIEW_DB_BRANCHES sets the list. See docs/ops/environments.md.`
  );
}
