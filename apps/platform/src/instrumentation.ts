/**
 * Runs once per server instance. Reports configuration problems at boot; the
 * health endpoint repeats them and returns 503, and the cron worker refuses to
 * run, so a misconfigured deployment fails visibly rather than half-working.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { checkConfig } = await import("./server/config");
  const { write } = await import("./lib/log");
  const report = checkConfig();
  for (const issue of report.errors) write("error", "config.invalid", { deployment: report.deployment, ...issue });
  for (const issue of report.warnings) write("warn", "config.degraded", { deployment: report.deployment, ...issue });
}
