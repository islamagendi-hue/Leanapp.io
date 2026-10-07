/**
 * The first-priority loop in a real browser:
 * sign up → organization → app → questionnaire → tracking plan → approve and
 * publish → SDK key → events → debugger → validation score, then the account,
 * settings and privacy pages the same customer would use.
 */
import { expect, test, type Page } from "@playwright/test";

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
  await page.waitForURL(/implementation\/questions/);
  appBase = page.url().replace(/\/implementation\/questions.*$/, "");
});

test("questionnaire → tracking plan → approve → publish", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/implementation/questions`);
  await answerQuestionnaire(page);
  await page.getByRole("button", { name: "Generate my tracking plan" }).click();
  await page.waitForURL(/implementation\/plan/);
  await expect(page.locator("details summary").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish plan" }).click();
  await page.waitForURL(/developers\/sdk/);
  sdkKey = (await page.content()).match(/la_pk_dev_[A-Za-z0-9_-]+/)![0];
});

test("events sent with the SDK key show up in the debugger and the score", async ({ page, request }) => {
  await signIn(page);
  await page.goto(`${appBase}/developers/debugger`);
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

  await page.goto(`${appBase}/implementation/validation`);
  await expect(page.getByText(/^\d+%$/).first()).toBeVisible();

  await page.goto(`${appBase}/analytics/events?env=development&event=order_completed`);
  await expect(page.getByRole("img", { name: "order_completed per day" })).toBeVisible();
  await page.goto(`${appBase}/analytics/funnels?env=development&step=app_installed&step=order_completed`);
  await expect(page.getByText(/of 1 people completed all 2 steps/)).toBeVisible();
});

test("mapping history: map an event, see the history, restore a revision", async ({ page }) => {
  await signIn(page);
  await page.goto(`${appBase}/implementation/validation`);
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
  await page.goto(`${appBase}/growth`);
  await page.getByRole("button", { name: "Turn on the growth model" }).click();
  await expect(page.getByRole("button", { name: "Turn off the growth model" })).toBeVisible();

  await page.goto(`${appBase}/growth/setup`);
  await page.selectOption('select[name="act_event"]', "order_completed");
  await page.selectOption('select[name="core_event"]', "order_completed");
  await page.selectOption('select[name="rev_event"]', "order_completed");
  await page.fill('[name="rev_amount"]', "value");
  await page.getByRole("button", { name: "Preview on the last 30 days" }).click();
  await expect(page.getByText("Preview: last 30 days")).toBeVisible();
  await expect(page.getByText("80 SAR")).toBeVisible();
  await page.getByRole("button", { name: /Save to draft/ }).click();
  await expect(page.getByText(/Saved in draft v\d+/)).toBeVisible();

  await page.goto(`${appBase}/implementation/plan`);
  await page.getByRole("button", { name: "Approve plan" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish plan" }).click();
  await page.waitForURL(/developers\/sdk/);

  // The scheduled worker builds growth state (here called directly, as pg_cron would).
  const cron = await request.get("/api/internal/process-events", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789"}` } });
  expect(cron.status()).toBe(200);
  await page.goto(`${appBase}/growth?env=development`);
  await expect(page.getByText("80 SAR")).toBeVisible();
  await expect(page.locator(".card", { hasText: "Paying" })).toContainText("100%");
  await page.goto(appBase);
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

  await page.goto(`${appBase}/privacy`);
  await page.fill('[name="userId"]', "u-42");
  await page.fill('[name="confirm"]', "delete");
  await page.getByRole("button", { name: "Delete data" }).click();
  await expect(page.getByText("Deletion queued")).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.locator("tbody tr").first()).toContainText("completed");
  }).toPass({ timeout: 15_000 });
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
