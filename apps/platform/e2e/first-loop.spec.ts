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
  await page.goto("/?lang=en");
  await page.getByRole("link", { name: "Start now" }).first().click();
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
  // The project switcher doesn't stay open once the pointer moves away, or on Escape.
  const switcher = page.locator("details", { has: page.locator('summary[title="Switch project"]') });
  await switcher.locator("summary").click();
  await expect(switcher).toHaveAttribute("open", "");
  await page.mouse.move(600, 500);
  await expect(switcher).not.toHaveAttribute("open");
  await switcher.locator("summary").click();
  await expect(switcher).toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect(switcher).not.toHaveAttribute("open");
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
  await expect(page.getByTestId("failed-count")).toHaveText("0");
  await expect(page.getByText("No failed events.")).toBeVisible();
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
  await expect(page.getByRole("img", { name: "Order Completed per day" })).toBeVisible();
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
  await expect(page.locator(".stat", { hasText: "Paying" })).toContainText("100%");
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

test("account menu: profile, team, API keys per environment, and Sign out", async ({ page }) => {
  await signIn(page);
  await page.goto(appBase);
  const menu = page.getByRole("banner").getByLabel("Your account");
  await menu.click();
  for (const item of ["Your profile", "Organization settings", "Members & invitations", "API keys", "Billing & plan"]) {
    await expect(page.getByRole("banner").getByRole("link", { name: item, exact: true })).toBeVisible();
  }
  await page.getByRole("banner").getByRole("link", { name: "Your profile" }).click();
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await page.getByRole("region", { name: "Profile" }).getByLabel("Name").fill("Sara Admin");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your organizations" }).getByText("Owner")).toBeVisible();

  await menu.click();
  await expect(page.getByRole("banner").getByText("Sara Admin")).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  for (const env of ["Production", "Staging", "Development"]) await expect(page.getByRole("cell", { name: env, exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Manage" }).first().click();
  await expect(page.getByRole("navigation", { name: "Environment" }).getByRole("link", { name: "Production" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("navigation", { name: "Environment" }).getByRole("link", { name: "Staging" }).click();
  await expect(page).toHaveURL(/env=staging/);

  await menu.click();
  await page.getByRole("banner").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("product shell: Overview home, Dev Ops in Settings, old addresses and the remembered environment", async ({ page }) => {
  await signIn(page);
  // A project opens on Overview; with no production events it points to Get started.
  await page.goto(appBase);
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your app" })).toBeVisible();
  const menu = page.getByRole("navigation", { name: "Food Express" });
  for (const name of ["Events & trends", "Funnels", "Users", "Audiences", "Flows", "A/B experiments", "Settings"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of ["SDK & API keys", "Debugger", "Tracking plan"]) await expect(menu.getByRole("link", { name })).toHaveCount(0);
  // Menu sections fold and unfold, and stay folded on the next page.
  const engagement = menu.getByRole("button", { name: "Engage Lab" });
  await engagement.click();
  await expect(engagement).toHaveAttribute("aria-expanded", "false");
  await expect(menu.getByRole("link", { name: "Flows", exact: true })).toBeHidden();
  await page.reload();
  await expect(menu.getByRole("link", { name: "Flows", exact: true })).toBeHidden();
  await menu.getByRole("button", { name: "Engage Lab" }).click();
  await expect(menu.getByRole("link", { name: "Flows", exact: true })).toBeVisible();
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

  // The environment chosen in project settings is remembered on every page, and the top bar says so.
  await page.goto(`${appBase}/settings/project/environments`);
  const env = page.getByRole("radiogroup", { name: "Environment" });
  await env.getByRole("radio", { name: "staging" }).click();
  await page.waitForURL(/env=staging/);
  await page.goto(`${appBase}/analytics/funnels`);
  await expect(page.getByText("Showing staging data.", { exact: false })).toBeVisible();
  await page.getByRole("banner").getByRole("link", { name: "Viewing Staging data" }).click();
  await page.waitForURL(/settings\/project\/environments/);
  await expect(env.getByRole("radio", { name: "staging" })).toHaveAttribute("aria-checked", "true");
  await env.getByRole("radio", { name: "production" }).click();
  await page.waitForURL(/env=production/);
  await expect(page.getByRole("banner").getByRole("link", { name: /Viewing .* data/ })).toHaveCount(0);
  // Later tests expect staging to be the remembered environment.
  await env.getByRole("radio", { name: "staging" }).click();
  await page.waitForURL(/env=staging/);
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
  // With one project and none archived, the workspace opens straight into it.
  await page.goto(`/o/${org}`);
  await page.waitForURL(appBase);
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
  for (const name of ["Events & trends", "Funnels", "Users", "Audiences", "CAC & LTV", "Ad spend", "Tracking links & QR", "Settings"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  for (const name of ["Flows", "A/B experiments"]) await expect(menu.getByRole("link", { name, exact: true })).toHaveCount(0);
  await v.goto(`${appBase}/analytics/events`);
  await expect(v.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();
  // Acquisition and attribution are read-only: no spend entry, CSV import or link creation.
  await v.goto(`${appBase}/acquisition/spend`);
  await expect(v.getByRole("button", { name: "Save spend" })).toHaveCount(0);
  await expect(v.getByRole("button", { name: "Import" })).toHaveCount(0);
  await v.goto(`${appBase}/acquisition/links`);
  await expect(v.getByRole("button", { name: "Create link" })).toHaveCount(0);

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
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: "u-77" })).toBeVisible();
  await page.getByLabel("Value 1").fill("Jeddah");
  await page.getByRole("button", { name: "Search", exact: true }).click();
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

test("dashboards: start from a template, add a widget, arrange it", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/analytics/dashboards?env=development`);
  const growth = page.locator('[data-template="growth"]');
  await expect(growth.getByText("DAU: active users per day")).toBeVisible();
  await growth.getByRole("button", { name: "Create Growth dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Growth", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MAU: active users, last 30 days" })).toBeVisible();

  await page.getByRole("link", { name: "Edit dashboard" }).click();
  await page.getByRole("link", { name: "Funnel", exact: true }).click();
  await page.getByRole("textbox", { name: "Title (optional)" }).fill("Install to order");
  await page.getByRole("combobox", { name: "Step 1" }).fill("app_installed");
  await page.getByRole("combobox", { name: "Step 2" }).fill("order_completed");
  await page.getByRole("button", { name: "Add funnel" }).click();
  const added = page.locator("section[data-widget]").filter({ has: page.getByRole("heading", { name: "Install to order" }) });
  await expect(added).toBeVisible();
  await added.getByRole("button", { name: "Move up" }).click();
  const titles = page.locator("section[data-widget] h2");
  await expect(titles.nth(-2)).toHaveText("Install to order");
  await page.getByRole("link", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
});

test("campaigns: audience, channel, message, schedule; the audience must be active to send", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/engage/campaigns?env=development`);
  await page.getByRole("link", { name: "New campaign" }).click();
  await page.getByRole("textbox", { name: "Campaign name" }).fill("Riyadh weekend");
  await page.getByRole("combobox", { name: "Audience" }).selectOption({ label: "Riyadh people (draft: activate it before sending)" });
  await page.getByRole("radio", { name: "In-app" }).check();
  await page.getByRole("textbox", { name: "Title" }).fill("Weekend offer");
  await page.getByRole("textbox", { name: "Message" }).fill("20% off this weekend");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: /Riyadh weekend/, level: 1 })).toBeVisible();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();
  await expect(page.getByText(/is a draft. Activate it before sending/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByText(/Activate the audience "Riyadh people" first/)).toBeVisible();

  await page.getByRole("link", { name: "Campaigns", exact: true }).first().click();
  await expect(page.getByRole("row").filter({ hasText: "Riyadh weekend" }).getByText("In-app")).toBeVisible();
});

test("experiments: create and start one, get a variant from the API, and see the exposure on the results page", async ({ page, request }) => {
  await signIn(page);
  await page.goto(`${appBase}/engage/campaigns?env=development`);
  await page.getByRole("navigation", { name: "Food Express" }).getByRole("link", { name: "A/B experiments", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Experiments/, level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "What works today" })).toContainText("A/B tests of campaign messages");
  await page.getByRole("link", { name: "New experiment" }).click();
  await page.getByLabel("Experiment name").fill("Checkout button");
  await page.getByLabel("Key used in your app's code").fill("checkout_button");
  await page.getByLabel("Goal event").fill("order_completed");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: /Checkout button/, level: 1 })).toBeVisible();
  await expect(page.getByText("draft", { exact: true })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Start experiment" }).click();
  await expect(page.getByText(/^Running\. The assignment API now returns/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/No one has been exposed yet/)).toBeVisible();

  const res = await request.post("/v1/experiments/assignments", { headers: { Authorization: `Bearer ${sdkKey}` }, data: { user_id: "u-exp-1", anonymous_id: "dev-exp-1" } });
  expect(res.status()).toBe(200);
  const a = (await res.json()).assignments.find((x: { experiment: string }) => x.experiment === "checkout_button");
  expect(["control", "treatment"]).toContain(a.variant);
  const sent = await request.post("/v1/events/batch", {
    headers: { Authorization: `Bearer ${sdkKey}` },
    data: { batch: [{ type: "track", event_name: "experiment_exposure", event_id: crypto.randomUUID(), anonymous_id: "dev-exp-1", user_id: "u-exp-1", properties: { experiment: "checkout_button", experiment_id: a.experiment_id, variant: a.variant } }] },
  });
  expect(await sent.json()).toMatchObject({ accepted: 1, rejected: [] });
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("region", { name: "Experiment summary" })).toContainText("People exposed1", { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByText(/Not enough data yet\. Each variant needs 100 exposed people/)).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: a.variant === "control" ? "Control" : "Treatment" }).getByRole("cell").nth(1)).toHaveText("1");
});

test("channels & delivery: health, honest numbers, and a test send", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/engage/channels?env=development`);
  await expect(page.getByRole("heading", { name: "Channels & delivery", level: 1 })).toBeVisible();
  const push = page.getByRole("region", { name: "Push" });
  await expect(push.getByText("Not connected")).toBeVisible();
  await expect(push.getByText(/Not available. FCM and APNs don't report delivery/)).toBeVisible();
  const inApp = page.getByRole("region", { name: "In-app" });
  await expect(inApp.getByText("Beta", { exact: true })).toBeVisible();
  await inApp.getByText("Send a test").click();
  await inApp.getByRole("textbox", { name: /User ID/ }).fill("u-77");
  await inApp.getByRole("button", { name: "Send In-app test" }).click();
  await expect(inApp.getByText(/Queued. Your app shows it/)).toBeVisible();
  await push.getByText("Send a test").click();
  await push.getByRole("textbox", { name: /User ID/ }).fill("u-77");
  await push.getByRole("button", { name: "Send Push test" }).click();
  await expect(push.getByText(/no active push token/)).toBeVisible();
});

test("flow builder: trigger, steps with an insert menu, goal and exit event", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/engage/automations?env=development`);
  await expect(page.getByRole("heading", { name: "Flows", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "New flow" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("First order nudge");
  await page.getByRole("combobox", { name: "Event", exact: true }).fill("app_installed");
  await expect(page.getByText("End of flow")).toBeVisible();
  await page.getByRole("combobox", { name: "Insert a step here" }).last().selectOption({ label: "In-app message" });
  const inApp = page.locator('[data-step="in_app"]');
  await inApp.getByRole("textbox").first().fill("Your first order ships free");
  await inApp.locator("textarea").fill("Order today");
  await page.getByRole("combobox", { name: "Insert a step here" }).last().selectOption({ label: "Exit" });
  await expect(page.locator('[data-step="exit"]')).toBeVisible();
  await page.getByRole("checkbox", { name: "Conversion goal" }).check();
  await page.getByRole("combobox", { name: "Goal event" }).fill("order_completed");
  await page.getByRole("checkbox", { name: "Exit event" }).check();
  await page.getByRole("combobox", { name: "Exit event" }).fill("app_uninstalled");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: /First order nudge/, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Goal: order_completed within 7 days" })).toBeVisible();
  const flow = page.getByRole("list", { name: "Flow" });
  await expect(flow.getByText("In-app message: Your first order ships free")).toBeVisible();
  await expect(flow.getByText("Exit", { exact: true })).toBeVisible();
  await expect(page.getByText(/Exit event: app_uninstalled/)).toBeVisible();
});

test("flows library: filter, preview the steps, and create a filled-in draft in one click", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/engage/automations?env=development`);
  const library = page.getByRole("region", { name: "Flows library" });
  await library.getByRole("combobox", { name: "Category" }).selectOption("conversion");
  await library.getByRole("searchbox", { name: "Search" }).fill("cart");
  await library.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/category=conversion/);
  await expect(library.getByText(/^Showing \d+ of \d+ flows$/)).toBeVisible();
  await expect(library.locator('[data-flow-template="welcome_series"]')).toHaveCount(0);
  const card = library.locator('[data-flow-template="abandoned_cart"]');
  // The purchase slot is mapped to the event this app already sends, and push shows as not connected yet.
  await expect(card.getByLabel("Purchase event")).toHaveValue("order_completed");
  await expect(card.getByText("sent by your app")).toBeVisible();
  await expect(card.getByText("Push isn't connected in development.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Connect Push" })).toHaveAttribute("href", /settings\/dev-ops\/channels/);
  await card.getByText("Preview the steps").click();
  await expect(card.getByText("You left something in your cart")).toBeVisible();
  await card.getByRole("button", { name: "Use this flow" }).click();
  await expect(page.getByRole("heading", { name: /Abandoned cart/, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Goal: order_completed within 3 days" })).toBeVisible();
});

test("acquisition (beta): overview, sources, attribution, and a tracking link with its QR code", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/acquisition?env=development`);
  await expect(page.getByRole("heading", { name: "Acquisition Beta", level: 1 })).toBeVisible();
  await expect(page.getByText("What Acquisition (Beta) measures")).toBeVisible();
  await expect(page.getByRole("region", { name: "Acquisition numbers" }).getByText("Installs", { exact: true })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Acquisition" });
  await tabs.getByRole("link", { name: "Sources & campaigns" }).click();
  await expect(page.getByRole("heading", { name: "Sources & campaigns Beta", level: 1 })).toBeVisible();
  await expect(page.getByText(/No cost or CPI here: enter spend on the Ad spend page/)).toBeVisible();
  // Ad spend: entered by hand or by CSV; a CSV with a wrong row saves nothing and names the line.
  await tabs.getByRole("link", { name: "Ad spend" }).click();
  await expect(page.getByRole("heading", { name: "Ad spend Beta", level: 1 })).toBeVisible();
  await page.getByRole("combobox", { name: "Source" }).fill("tiktok");
  await page.getByRole("textbox", { name: "Amount" }).fill("1250.50");
  await page.getByRole("button", { name: "Save spend" }).click();
  await expect(page.getByText("Spend saved.")).toBeVisible();
  await expect(page.getByTestId("spend-entries").getByRole("row", { name: /tiktok/ })).toContainText("1,250.5");
  await page.getByRole("textbox", { name: "Paste CSV" }).fill("2026-01-02,snap,,SAR,10\n2026-01-03,snap,,SAR,ten");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/^Line 2: /)).toBeVisible();
  await expect(page.getByTestId("spend-entries").getByRole("row", { name: /snap/ })).toHaveCount(0);
  await expect(page.locator('a[href*="/analytics/revenue?env=development&by=channel"]')).toHaveText("Revenue");
  await tabs.getByRole("link", { name: "Attribution" }).click();
  await expect(page.getByRole("heading", { name: "How installs were matched" })).toBeVisible();
  // Honest labels: self-reported sources are not "deterministic", and paid iOS installs are unattributed.
  await expect(page.getByRole("cell", { name: "Reported", exact: true })).toBeVisible();
  await expect(page.getByTestId("ios-attribution-note")).toContainText("can't be attributed deterministically without SKAdNetwork / AdAttributionKit or Apple Search Ads");
  await expect(page.getByRole("link", { name: "SKAdNetwork setup" })).toHaveAttribute("href", /settings\/dev-ops\/attribution\/skan$/);
  await expect(page.getByText("Multi-touch and view-through attribution")).toBeVisible();

  await tabs.getByRole("link", { name: "Tracking links & QR" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Poster QR");
  await page.getByRole("textbox", { name: "Source" }).fill("offline");
  await page.getByRole("textbox", { name: "Web fallback URL" }).fill("https://example.com/app");
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("cell", { name: /Poster QR/ })).toBeVisible();
  await page.getByRole("row", { name: /Poster QR/ }).getByRole("link", { name: "URL & QR" }).click();
  const share = page.getByRole("region", { name: "URL and QR code" });
  await expect(share.getByRole("link", { name: "Download SVG" })).toBeVisible();
  // The old address of a link's QR code (on Deep links) forwards here.
  const code = new URL(page.url()).searchParams.get("link");
  await page.goto(`${appBase}/acquisition/deep-links?env=development&link=${code}`);
  await expect(page).toHaveURL(/\/acquisition\/links\?/);
  await expect(page.getByRole("region", { name: "URL and QR code" })).toBeVisible();

  // Deep links says what works today, and never claims deferred deep linking is live.
  await page.getByRole("navigation", { name: "Acquisition" }).getByRole("link", { name: "Deep links" }).click();
  const today = page.getByRole("region", { name: "What works today" });
  await expect(today.locator('[data-capability="fallback"]').getByText("Live", { exact: true })).toBeVisible();
  await expect(today.locator('[data-capability="ios"]').getByText("Needs setup")).toBeVisible();
  await expect(today.locator('[data-capability="deferred"]')).not.toContainText("Live");
  await expect(page.getByText(/through the install/)).toHaveCount(0);
  await expect(today.getByRole("link", { name: "Deep link setup" })).toHaveAttribute("href", /settings\/dev-ops\/deep-links/);
});

test("SDK & API keys: real quickstarts for every SDK, and an honest release status", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/settings/dev-ops/sdk?env=development`);
  const status = page.getByRole("region", { name: "SDK release status" });
  for (const sdk of ["JavaScript / React Native", "Android (Kotlin)", "iOS (Swift)", "Flutter (Dart)"]) await expect(status.getByRole("cell", { name: sdk })).toBeVisible();
  await expect(status.getByText("Not published", { exact: true })).toHaveCount(4);
  await page.getByRole("tab", { name: "Android (Kotlin)" }).click();
  await expect(page.getByText(/AnalyticsOptions\(endpoint = /)).toBeVisible();
  await expect(page.getByText("Not published to Maven Central yet", { exact: false })).toBeVisible();
  await expect(page.getByText("Target API")).toHaveCount(0);
  await expect(page.getByText("npm install @leanapp")).toHaveCount(0);
});

test("overview: key numbers for the selected environment, and Connect your app while production is empty", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}?env=development`);
  // Development has data, so the setup reminder is one line above the numbers.
  await expect(page.getByText("Production isn't receiving events yet", { exact: false })).toBeVisible();
  const numbers = page.getByRole("region", { name: "Key numbers" });
  for (const label of ["Active users", "New users", "Events"]) await expect(numbers.getByText(label, { exact: true })).toBeVisible();
  for (const heading of ["Active users per day", "Activation", "Retention", "Key funnel", "Top events"]) await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Order Completed/ })).toBeVisible();
  const range = page.getByRole("form", { name: "Range" });
  await range.getByLabel("Range").selectOption("15");
  await expect(page).toHaveURL(/days=15/);
  await expect(page.getByText(/last 15 days, compared with/)).toBeVisible();
  await range.getByLabel("Compare with").selectOption("year");
  await expect(page).toHaveURL(/compare=year/);
  await expect(page.getByText(/compared with \d+ \w+ 2025/)).toBeVisible();
  await range.getByLabel("Range").selectOption("custom");
  await range.getByLabel("From", { exact: true }).fill("2026-09-01");
  await range.getByLabel("To", { exact: true }).fill("2026-09-10");
  await expect(page).toHaveURL(/from=2026-09-01&to=2026-09-10/);
  // The test data is all from the last few days, so this range is empty.
  await expect(page.getByText(/No events in development in 1 Sept 2026 – 10 Sept 2026 yet/)).toBeVisible();
});

test("charts: the trend chart answers the pointer and keys, and key numbers count up to their real value", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const url = `${appBase}?env=development`;
  await page.goto(url);
  // The number ends at the value the server rendered, and the server HTML already holds it.
  const tile = page.getByRole("region", { name: "Key numbers" }).locator("[data-count]").first();
  const final = (await tile.getAttribute("data-count"))!;
  expect(final).toMatch(/[1-9]/);
  await expect(tile).toHaveText(final);
  expect(await (await page.request.get(url)).text()).toMatch(new RegExp(`data-count="${final}"[^>]*>${final}<`));

  const chart = page.locator("[data-chart-hover]").first();
  const tip = chart.locator("[data-chart-tooltip]");
  await expect(tip).toHaveCount(0);
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2);
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Active users");
  await expect(tip).toContainText(/\d{1,2} \w{3,} \d{4}/);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
  await expect(tip).toHaveCount(0);
  // Keyboard: focus the chart and move through the days.
  await chart.focus();
  await page.keyboard.press("Home");
  await expect(tip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tip).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("reports apply as you change them, funnel bars open their people, and Ctrl+K jumps anywhere", async ({ page, request }) => {
  const ctx = { platform: "android", app_version: "2.3.0" };
  const sent = await request.post("/v1/events/batch", {
    headers: { Authorization: `Bearer ${sdkKey}` },
    data: { batch: [
      { type: "track", event_name: "app_installed", event_id: crypto.randomUUID(), anonymous_id: "dev-funnel", user_id: "u-funnel", context: ctx },
      { type: "track", event_name: "order_completed", event_id: crypto.randomUUID(), anonymous_id: "dev-funnel", user_id: "u-funnel", properties: { order_id: "of1", value: 50, currency: "SAR" }, context: ctx },
    ] },
  });
  expect(sent.status()).toBe(200);
  await request.get("/api/internal/process-events", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789"}` } });
  await signIn(page);
  await page.goto(`${appBase}/analytics/funnels?env=development&step=app_installed&step=order_completed&fresh=1`);
  await expect(page.getByRole("button", { name: "Show funnel" })).toBeHidden();
  await page.getByRole("link", { name: "See who reached it" }).last().click();
  const panel = page.getByRole("region", { name: "People behind this step" });
  await expect(panel.getByRole("heading", { name: /Reached step 2 \(Order Completed\)/ })).toBeVisible();
  await expect(panel.getByRole("link", { name: "u-funnel" })).toBeVisible();
  // Changing a setting re-runs the report: no button to press.
  await page.getByLabel("Converted within").selectOption("1");
  await expect(page).toHaveURL(/window=1/);

  await page.goto(`${appBase}/analytics/retention?env=development`);
  await expect(page.getByLabel("Return event")).toHaveValue("$any");

  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Quick search" });
  await search.getByRole("textbox").fill("funnels");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/analytics\/funnels/);
  await page.keyboard.press("Control+k");
  await search.getByRole("textbox").fill("order completed");
  await expect(search.getByRole("option", { name: /Order Completed/ })).toBeVisible();
});

test("retention: Churn and RFM segments, and a group saved as an audience", async ({ page, request }) => {
  const ctx = { platform: "android", app_version: "2.3.0" };
  const order = (user: string, n: number, revenue: number) =>
    ({ type: "track", event_name: "order_completed", event_id: crypto.randomUUID(), anonymous_id: `dev-${user}`, user_id: user, properties: { order_id: `${user}-${n}`, revenue, price: revenue, currency: "SAR" }, context: ctx });
  const sent = await request.post("/v1/events/batch", {
    headers: { Authorization: `Bearer ${sdkKey}` },
    data: { batch: [order("u-rfm-1", 1, 120), order("u-rfm-1", 2, 80), order("u-rfm-2", 1, 30)] },
  });
  expect(sent.status()).toBe(200);
  await request.get("/api/internal/process-events", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789"}` } });
  await signIn(page);
  await page.goto(`${appBase}?env=development`);
  const menu = page.getByRole("navigation", { name: "Food Express Pro" });
  await menu.getByRole("link", { name: "Churn", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Churn", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Retention" }).getByRole("link", { name: "Churn" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("churn-buckets")).toContainText("At risk");
  await page.getByLabel("Churn window").selectOption("60");
  await expect(page).toHaveURL(/window=60/);
  await page.getByTestId("churn-buckets").getByRole("row", { name: /Churned/ }).getByRole("button", { name: "Save as audience" }).click();
  await expect(page.getByRole("heading", { name: /Churned: not seen in 60 days/, level: 1 })).toBeVisible();
  await expect(page.getByText("last seen more than 60 days ago").first()).toBeVisible();

  await menu.getByRole("link", { name: "RFM segments", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RFM segments", level: 1 })).toBeVisible();
  await expect(page.getByTestId("rfm-grid")).toBeVisible();
  await expect(page.getByTestId("rfm-segments").locator("article")).toHaveCount(11);
  await page.getByTestId("rfm-segments").locator('[data-segment="champions"]').getByRole("button", { name: "Save as audience" }).click();
  await expect(page.getByRole("heading", { name: /RFM: Champions \(SAR, last 365 days\)/, level: 1 })).toBeVisible();
  await expect(page.getByText("in RFM segment Champions (SAR, last 365 days)").first()).toBeVisible();
  await menu.getByRole("link", { name: "Retention", exact: true }).click();
  await expect(page.getByLabel("Return event")).toBeVisible();
});

test("landing page: Arabic and English, honest labels, comparison, pricing, and noindex", async ({ page }) => {
  await page.goto("/?lang=ar");
  await expect(page.locator("div[dir=rtl][lang=ar]").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("اعرف مستخدميك، وطوّر تطبيقك.");
  await page.getByRole("link", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Know your users. Grow your app.");
  // The home page is short: features, pricing and about are their own pages, opened from the top tabs.
  await expect(page.getByRole("heading", { name: "What's in it" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Pricing" })).toHaveCount(0);
  const compare = page.getByRole("table");
  await expect(compare.getByRole("columnheader")).toHaveText(["What you need", "LeanApp", "Mixpanel", "Adjust", "MoEngage"]);
  await expect(compare.getByRole("row", { name: /Install attribution/ }).getByRole("cell").first()).toContainText("Beta");
  const tabs = page.getByRole("navigation", { name: "Sections" }).first();
  await tabs.getByRole("link", { name: "Features" }).click();
  await expect(page).toHaveURL(/\/features\?lang=en$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What's in it");
  await expect(page.getByRole("list", { name: "Product flow" }).getByRole("link")).toHaveText(["Connect", "Collect", "Understand", "Funnels", "Retention", "Audiences", "Act"]);
  const connect = page.getByRole("article", { name: "Connect your app" });
  await expect(connect.getByRole("listitem").filter({ hasText: "Android, iOS and Flutter SDKs" }).getByText("Beta", { exact: true })).toBeVisible();
  const act = page.getByRole("article", { name: "Act on it" });
  await expect(act.getByRole("listitem").filter({ hasText: "Acquisition" })).toContainText("Not a full mobile measurement partner");
  await expect(page.getByRole("heading", { name: "Coming next" })).toBeVisible();
  await tabs.getByRole("link", { name: "Pricing" }).click();
  await expect(page.getByRole("listitem", { name: "Growth" })).toContainText("$599");
  await expect(page.getByRole("listitem", { name: "Enterprise" })).toContainText("Contact sales");
  await tabs.getByRole("link", { name: "About us" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who we are");
  await expect(tabs.getByRole("link", { name: "About us" })).toHaveAttribute("aria-current", "page");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});

test("developer guide: public, Arabic and English, the four SDKs and an honest release status", async ({ page }) => {
  await page.goto("/?lang=ar");
  await page.getByRole("navigation", { name: "الأقسام" }).first().getByRole("link", { name: "للمطوّرين" }).click();
  await expect(page).toHaveURL(/\/developers\?lang=ar$/);
  await expect(page.locator("div[dir=rtl][lang=ar]").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("أضف LeanApp إلى تطبيقك");
  const sdks = ["JavaScript / React Native", "Android (Kotlin)", "iOS (Swift)", "Flutter (Dart)"];
  await expect(page.locator("#sdks").getByRole("heading", { level: 3 })).toHaveText(sdks);
  await expect(page.locator("#code pre").first()).toHaveAttribute("dir", "ltr");

  await page.goto("/developers?lang=en");
  await expect(page.locator("div[dir=ltr][lang=en]").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add LeanApp to your app");
  await expect(page.locator("#sdks").getByRole("heading", { level: 3 })).toHaveText(sdks);
  await expect(page.getByRole("listitem", { name: "Android (Kotlin)" })).toContainText("Not public yet: available from us during onboarding.");
  await expect(page.getByRole("heading", { name: "Notes and recommendations" })).toBeVisible();
  await expect(page.locator("#deep-links")).toContainText("not called by the SDKs yet");
  await page.getByRole("link", { name: "العربية" }).click();
  await expect(page).toHaveURL(/\/developers$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("أضف LeanApp إلى تطبيقك");
  await page.getByRole("link", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add LeanApp to your app");
});

test("the app switches to Arabic, right to left, and back", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await page.getByRole("link", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("تسجيل الدخول");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole("link", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
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
