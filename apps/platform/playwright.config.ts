import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive a real browser against a production build
 * (`npm run build` first) and a migrated database in DATABASE_URL.
 */
const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start --port ${port}`,
    url: `http://localhost:${port}/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { CRON_SECRET: process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789" },
  },
});
