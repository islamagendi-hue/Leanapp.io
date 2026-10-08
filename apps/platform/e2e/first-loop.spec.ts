/**
 * The first-priority loop in a real browser:
 * sign up → organization → app → questionnaire → tracking plan → approve and
 * publish → SDK key → events → debugger → validation score, then the account,
 * settings and privacy pages the same customer would use.
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

test.describe.configure({ mode: "serial" });

const email = `e2e-${Date.now()}@example.com`;
const password = "correct-horse-9";
let appBase = "";
let sdkKey = "";

/** Answers whatever the questionnaire shows until it offers to generate the plan. */
async function answerQuestionnaire(page: Page) {
  const text: Record<string, string> = {
    "business.description": "We are a food delivery app in Saudi Arabia. Users choose restaurants, add meals to cart, checkout and pay online.",
    "journey.description": "Users see a TikTok ad, install the app, register, choose a restaurant, add meals to cart, checkout and pay.",
    "app.primary_action": "Order food",
  };
  const prefer: Record<string, string> = { "business.model": "delivery", "app.has_signup": "true" };
  for (let round = 0; round < 15; round++) {
    if (await page.getByRole("button", { name: "Generate my tracking plan" }).count()) return;
    for (const [name, value] of Object.entries(text)) {
      const el = page.locator(`[name="${name}"]`);
      if ((await el.count()) && !(await el.inputValue())) await el.fill(value);
    }
    for (const el of await page.locator("textarea[required], input.input[required]").all()) if (!(await el.inputValue())) await el.fill("Customers");
    const groups = await page.locator("fieldset input[type=radio], fieldset input[type=checkbox]").evaluateAll((els) => [...new Set(els.map((e) => (e as HTMLInputElement).name))]);
    for (const name of groups) {
      if (await page.locator(`input[name="${name}"]:checked`).count()) continue;
      const values = await page.locator(`input[name="${name}"]:not([value="__other"])`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      const pick = prefer[name] && values.includes(prefer[name]) ? prefer[name] : ["false", "tiktok", "none"].find((v) => values.includes(v)) ?? values[0];
      await page.check(`input[name="${name}"][value="${pick}"]`);
    }
    const heading = await page.locator("main h2").first().textContent();
    await page.getByRole("button", { name: "Save and continue" }).click();
    // The section changes, or the same section shows follow-up questions.
    await page
      .waitForFunction((h) => document.querySelector("main h2")?.textContent !== h || !!document.querySelector("form [role=alert]"), heading, { timeout: 4000 })
      .catch(() => {});
    await expect(page.locator("form [role=alert]")).toHaveCount(0);
  }
  throw new Error("Questionnaire did not complete");
}

test("sign up, create an organization and an app", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await page.fill('[name="name"]', "Sara Ali");
  await page.fill('[name="email"]', email);
  await page.fill('[name="password"]', password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/onboarding/);
  await page.fill('[name="name"]', "E2E Foods");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(/apps\/new/);
  await expect(page.getByText("Please confirm your email address")).toBeVisible();
  await page.fill('[name="name"]', "Food Express");
  for (const cb of await page.locator('input[name="platforms"]').all()) await cb.check();
  await page.getByRole("button", { name: "Create app and continue" }).click();
  await page.waitForURL(/dev-ops\/implementation\/questions/);
  appBase = page.url().replace(/\/settings\/dev-ops\/implementation\/questions.*$/, "");
});

test("questionnaire → tracking plan → approve → publish", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/settings/dev-ops/implementation/questions`);
  await answerQuestionnaire(page);
  await page.getByRole("button", { name: "Generate my tracking plan" }).click();
  await page.waitForURL(/implementation\/plan/);
  await expect(page.locator("details summary").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish plan" }).click();
  await page.waitForURL(/dev-ops\/sdk/);
  sdkKey = (await page.content()).match(/la_pk_dev_[A-Za-z0-9_-]+/)![0];
});

test("events sent with the SDK key show up in the debugger and the score", async ({ page, request }) => {
  await signIn(page);
  await page.goto(`${appBase}/settings/dev-ops/debugger?env=development`);
  await expect(page.getByText("Waiting for first event")).toBeVisible();
  const ctx = { platform: "ios", app_version: "2.3.0", sdk: { name: "leanapp-js", version: "0.1.0" }, attribution: { utm_source: "tiktok" } };
  const res = await request.post("/v1/events/batch", {
    headers: { Authorization: `Bearer ${sdkKey}` },
    data: {
      batch: [
        { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "dev-1", session_id: "s1", context: ctx },
        { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "dev-1", user_id: "u-42", user_properties: { city: "Riyadh" }, context: ctx },
        { type: "track", event_name: "order_completed", event_id: crypto.randomUUID(), anonymous_id: "dev-1", user_id: "u-42", session_id: "s1", properties: { order_id: "o1", value: 80, currency: "SAR" }, context: ctx },
      ],
    },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).accepted).toBe(3);
  await expect(page.getByRole("cell", { name: "order_completed" }).first()).toBeVisible({ timeout: 15_000 });

  await page.goto(`${appBase}/settings/dev-ops/events`);
  await expect(page.getByText(/^\d+%$/).first()).toBeVisible();

  await page.goto(`${appBase}/analytics/events?env=development&event=order_completed`);
  await expect(page.getByRole("img", { name: "order_completed per day" })).toBeVisible();
  await page.goto(`${appBase}/analytics/funnels?env=development&step=app_installed&step=order_completed`);
  await expect(page.getByText(/of 1 people who started in the last 30 days completed all 2 steps/)).toBeVisible();
});

test("mapping history: map an event, see the history, restore a revision", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/settings/dev-ops/events?env=development`);
  await page.getByRole("button", { name: "Turn on mapping history" }).click();
  await expect(page.getByText("Mapping history on.")).toBeVisible();
  const addMapping = async (to: string) => {
    await page.fill('[name="from"]', "Checkout");
    await page.selectOption('select[name="to"]', to);
    await page.getByRole("button", { name: "Add mapping" }).click();
    await expect(page.getByText("Mapping saved")).toBeVisible();
  };
  await addMapping("order_completed");
  const other = await page.locator('select[name="to"] option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).find((v) => v !== "order_completed")!);
  await page.reload();
  await addMapping(other);
  await page.reload();
  await expect(page.getByRole("cell", { name: `Checkout → ${other}` })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("row", { name: /Checkout → order_completed/ }).getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Reverted to revision 1.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("(restored 1)")).toBeVisible();
});

test("growth: turn on, define, preview, publish, see the summary", async ({ page, request }) => {
  await signIn(page);
  await page.goto(`${appBase}/growth?env=development`);
  await page.getByRole("button", { name: "Turn on the growth model" }).click();
  await expect(page.getByRole("button", { name: "Turn off the growth model" })).toBeVisible();

  await page.goto(`${appBase}/growth/setup?env=development`);
  await page.selectOption('select[name="act_event"]', "order_completed");
  await page.selectOption('select[name="core_event"]', "order_completed");
  await page.selectOption('select[name="rev_event"]', "order_completed");
  await page.fill('[name="rev_amount"]', "value");
  await page.getByRole("button", { name: "Preview on the last 30 days" }).click();
  await expect(page.getByText("Preview: last 30 days")).toBeVisible();
  await expect(page.getByText("80 SAR")).toBeVisible();
  await page.getByRole("button", { name: /Save to draft/ }).click();
  await expect(page.getByText(/Saved in draft v\d+/)).toBeVisible();

  await page.goto(`${appBase}/settings/dev-ops/implementation/plan`);
  await page.getByRole("button", { name: "Approve plan" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish plan" }).click();
  await page.waitForURL(/dev-ops\/sdk/);

  // The scheduled worker builds growth state (here called directly, as pg_cron would).
  const cron = await request.get("/api/internal/process-events", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789"}` } });
  expect(cron.status()).toBe(200);
  await page.goto(`${appBase}/growth?env=development`);
  await expect(page.getByText("80 SAR")).toBeVisible();
  await expect(page.locator(".card", { hasText: "Paying" })).toContainText("100%");
  await page.goto(`${appBase}/settings/dev-ops/get-started`);
  await expect(page.getByText("See your growth summary")).toBeVisible();
});

test("account, settings and privacy pages", async ({ page }) => {
  await signIn(page);
  await page.goto("/account");
  await expect(page.getByText("not confirmed")).toBeVisible();
  await expect(page.getByText("This device")).toBeVisible();

  const org = new URL(appBase).pathname.split("/")[2];
  await page.goto(`/o/${org}/settings`);
  await page.fill('[name="name"]', "E2E Foods Ltd");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.goto(`/o/${org}/settings/audit`);
  await expect(page.getByText("organization.updated")).toBeVisible();
  await page.goto(`/o/${org}/settings/usage`); // old link redirects to Plan & billing
  await expect(page.getByText("Events this month")).toBeVisible();
  await expect(page.getByText("Payments are not connected yet.", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Starter" })).toBeDisabled();

  await page.goto(`${appBase}/settings/privacy?env=development`);
  await page.fill('[name="userId"]', "u-42");
  await page.fill('[name="confirm"]', "delete");
  await page.getByRole("button", { name: "Delete data" }).click();
  await expect(page.getByText("Deletion queued")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.locator("tbody tr").first()).toContainText("completed");
  }).toPass({ timeout: 15_000 });
});

test("product shell: Overview home, Dev Ops in Settings, old addresses and the remembered environment", async ({ page }) => {
  await signIn(page);
  // A project opens on Overview; with no production events it points to Get started.
  await page.goto(appBase);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your app" })).toBeVisible();
  const menu = page.getByRole("navigation", { name: "Food Express" });
  for (const name of ["Events & trends", "Funnels", "Users", "Audiences", "Flows", "Settings"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of ["SDK & API keys", "Debugger", "Tracking plan"]) await expect(menu.getByRole("link", { name })).toHaveCount(0);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.waitForURL(/settings\/dev-ops\/get-started/);
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "SDK & API keys" })).toBeVisible();

  // Old addresses forward to their new places, query string included.
  await page.goto(`${appBase}/developers/sdk?env=development`);
  await expect(page).toHaveURL(/\/settings\/dev-ops\/sdk\?env=development$/);
  await page.goto(`${appBase}/implementation/validation`);
  await expect(page).toHaveURL(/\/settings\/dev-ops\/events$/);
  await page.goto(`${appBase}/attribution/links`);
  await expect(page).toHaveURL(/\/acquisition\/links$/);

  // The environment chosen in the top bar is remembered on the next page.
  await page.goto(`${appBase}/analytics/events`);
  const env = page.getByRole("radiogroup", { name: "Environment" });
  await env.getByRole("radio", { name: "staging" }).click();
  await page.waitForURL(/env=staging/);
  await page.goto(`${appBase}/analytics/funnels`);
  await expect(env.getByRole("radio", { name: "staging" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Showing staging data.", { exact: false })).toBeVisible();
});

test("project settings: rename, timezone, environments, archive and restore", async ({ page }) => {
  await signIn(page);
  const org = new URL(appBase).pathname.split("/")[2];
  await page.goto(`${appBase}/settings`);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "General" }).last().click();
  await page.waitForURL(/settings\/project$/);
  await page.fill('[name="name"]', "Food Express Pro");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Food Express Pro" })).toBeVisible();
  expect(page.url()).toContain(appBase); // the address doesn't change on rename

  await page.goto(`${appBase}/settings/project/timezone`);
  await page.selectOption('[name="timezone"]', "Asia/Dubai");
  await page.selectOption('[name="currency"]', "AED");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved. Reports use", { exact: false })).toBeVisible();

  page.on("dialog", (d) => d.accept());
  await page.goto(`${appBase}/settings/project/environments`);
  const staging = page.locator("li", { hasText: "Staging" });
  await staging.getByRole("button", { name: "Pause" }).click();
  await expect(staging.getByText("Paused", { exact: true })).toBeVisible();
  await staging.getByRole("button", { name: "Resume" }).click();
  await expect(staging.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.locator("li", { hasText: "Production" }).getByRole("button")).toHaveCount(0);

  await page.goto(`${appBase}/settings/project`);
  await page.getByRole("button", { name: "Archive project" }).click();
  await page.waitForURL(new RegExp(`/o/${org}$`));
  await expect(page.getByRole("link", { name: /Food Express Pro/ })).toHaveCount(0);
  await page.getByText("Archived projects (1)").click();
  await page.getByRole("link", { name: "Restore or view" }).click();
  await expect(page.getByText("This project is archived, so it receives no events.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Restore project" }).click();
  await expect(page.getByText("Project restored.", { exact: false })).toBeVisible();
  await page.goto(`/o/${org}`);
  await expect(page.getByRole("link", { name: /Food Express Pro/ }).filter({ visible: true })).toBeVisible();
});

test("a viewer sees reports and people, and can change nothing", async ({ page, browser }) => {
  await signIn(page);
  const org = new URL(appBase).pathname.split("/")[2];
  const viewerEmail = `viewer-${Date.now()}@example.com`;
  await page.goto(`/o/${org}/settings/members`);
  await page.fill('[name="email"]', viewerEmail);
  await page.selectOption('[name="role"]', "viewer");
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = (await page.locator("code").filter({ hasText: "/invite/" }).textContent())!.trim();

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto(new URL(link).pathname);
  await v.fill('[name="name"]', "Vera Viewer");
  await v.fill('[name="email"]', viewerEmail);
  await v.fill('[name="password"]', password);
  await v.getByRole("button", { name: "Create account" }).click();
  await v.waitForURL(/\/invite\//);
  // The confirmation email isn't readable here, so confirm the address directly.
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("update platform.users set email_verified_at = now() where email = $1", [viewerEmail]);
  await db.end();
  await v.reload();
  await v.getByRole("button", { name: "Accept invitation" }).click();
  await v.waitForURL(new RegExp(`/o/${org}`));

  await v.goto(appBase);
  await expect(v.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(v.getByRole("link", { name: "Get started" })).toHaveCount(0);
  const menu = v.getByRole("navigation", { name: "Food Express Pro" });
  for (const name of ["Events & trends", "Funnels", "Users", "Audiences", "Settings"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of ["Flows", "Tracking links & QR"]) await expect(menu.getByRole("link", { name, exact: true })).toHaveCount(0);
  await v.goto(`${appBase}/analytics/events`);
  await expect(v.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();

  await v.goto(`${appBase}/settings/project`);
  await expect(v.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(v.getByRole("button", { name: "Archive project" })).toHaveCount(0);
  await expect(v.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "SDK & API keys" })).toHaveCount(0);
  const res = await v.goto(`${appBase}/settings/dev-ops/sdk`);
  expect(res!.status()).toBe(404);
  await ctx.close();
});

test("property catalog: Attributes lists what the app sends, and Users filter by it", async ({ page, request }) => {
  await signIn(page);
  const res = await request.post("/v1/events/batch", {
    headers: { Authorization: `Bearer ${sdkKey}` },
    data: {
      batch: [
        { type: "identify", event_id: crypto.randomUUID(), anonymous_id: "dev-7", user_id: "u-77", user_properties: { city: "Riyadh" } },
        { type: "track", event_name: "order_completed", event_id: crypto.randomUUID(), anonymous_id: "dev-7", user_id: "u-77", properties: { order_id: "o7", value: 50, currency: "SAR" } },
      ],
    },
  });
  expect(res.status()).toBe(200);
  const city = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "city", exact: true }) });
  // Events are processed right after they're accepted; reload until they are.
  await expect(async () => {
    await page.goto(`${appBase}/settings/dev-ops/attributes?env=development`);
    await expect(city).toContainText("Riyadh", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Attributes", level: 1 })).toBeVisible();
  await city.getByText("Describe").click();
  await city.getByRole("textbox", { name: "Description of city" }).fill("Home city from the profile.");
  await city.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Description saved.")).toBeVisible();
  await page.getByRole("link", { name: /Event properties/ }).click();
  await expect(page.getByRole("cell", { name: "order_id", exact: true })).toBeVisible();

  await page.goto(`${appBase}/analytics/users?env=development`);
  await page.getByRole("combobox", { name: "Property 1" }).selectOption("city");
  await page.getByLabel("Value 1").fill("Riyadh");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: "u-77" })).toBeVisible();
  await page.getByLabel("Value 1").fill("Jeddah");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No user matches these filters.")).toBeVisible();
});

test("cohorts are audiences: an old cohort link opens the audience, which filters reports and Users", async ({ page }) => {
  await signIn(page);
  // A cohort saved before the change, copied the way the migration does it.
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows: [cohort] } = await db.query<{ id: string }>(
    `insert into platform.analytics_cohorts (organization_id, app_id, environment_id, name, definition)
     select e.organization_id, e.app_id, e.id, 'Riyadh people', '{"userProperty":{"name":"city","op":"eq","value":"Riyadh"}}'
       from platform.environments e join platform.apps a on a.id = e.app_id join platform.organizations o on o.id = a.organization_id
      where e.type = 'development' and '/o/' || o.slug || '/apps/' || a.slug = $1
     returning id`,
    [new URL(appBase).pathname],
  );
  await db.query("select platform.copy_cohorts_to_audiences()");
  await db.end();

  await page.goto(`${appBase}/analytics/cohorts/${cohort.id}`);
  await expect(page).toHaveURL(new RegExp(`/engage/audiences/${cohort.id}$`));
  await expect(page.getByRole("heading", { name: /Riyadh people/, level: 1 })).toBeVisible();
  const use = page.getByText("Use this audience in").locator("..");
  await use.getByRole("link", { name: "Users", exact: true }).click();
  await expect(page.getByRole("link", { name: "u-77" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "People in audience" })).toHaveValue(cohort.id);

  await page.goto(`${appBase}/analytics/events?env=development&cohort=${cohort.id}`);
  await expect(page.getByRole("combobox", { name: "People in audience" })).toHaveValue(cohort.id);
  // Opened again, the report comes from the short-lived result cache and says so.
  await page.reload();
  await expect(page.getByText(/Computed .* ago/)).toBeVisible();
  await page.getByRole("link", { name: "Refresh now" }).click();
  await expect(page).toHaveURL(/fresh=1/);
  await expect(page.getByText(/Computed .* ago/)).toHaveCount(0);
  await page.goto(`${appBase}/analytics/cohorts?env=development`);
  await expect(page).toHaveURL(/\/engage\/audiences\?env=development$/);
});

test("dashboards: create one, add a saved report, see it run", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/analytics/events?env=development&event=order_completed`);
  await page.getByText("Save this report").click();
  await page.getByRole("textbox", { name: "Name" }).fill("Orders");
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible();

  await page.getByRole("navigation", { name: "Food Express Pro" }).getByRole("link", { name: "Dashboards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboards", level: 1 })).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Team KPIs");
  await page.getByRole("button", { name: "Create dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Team KPIs", level: 1 })).toBeVisible();
  await expect(page.getByText("This dashboard is empty.")).toBeVisible();

  await page.goto(`${appBase}/analytics?env=development`);
  const row = page.getByRole("row").filter({ hasText: "Orders" });
  await row.getByRole("button", { name: "Add to dashboard" }).click();
  await expect(row.getByText("Added to the dashboard.")).toBeVisible();

  await page.goto(`${appBase}/analytics/dashboards?env=development`);
  await page.getByRole("link", { name: "Team KPIs" }).click();
  const widget = page.locator('[data-widget="trend"]');
  await expect(widget.getByText("Saved report: Orders")).toBeVisible();
  await expect(widget.getByText(/events ·/)).toBeVisible();
});

test("pages carry a CSP and the app has no console errors on load", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.goto("/login");
  expect(res!.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  expect(res!.headers()["x-request-id"]).toBeTruthy();
  await page.goto("/");
  expect(errors).toEqual([]);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.fill('[name="email"]', email);
  await page.fill('[name="password"]', password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}
