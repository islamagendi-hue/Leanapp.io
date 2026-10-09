import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { can } from "@/modules/rbac/authorize";
import { ROLES } from "@/modules/rbac/permissions";
import { activeHref, projectMenu, settingsMenu, type NavGroup } from "./menu";

const base = "/o/acme/apps/shop";
const links = (menu: NavGroup[]) => menu.flatMap((g) => [g.href, ...g.items.map((i) => i.href)]).filter((h): h is string => !!h);
const labels = (menu: NavGroup[]) => menu.flatMap((g) => [g.label, ...g.items.map((i) => `${g.label}/${i.label}`)]);

/** The app/ page that serves a menu link, with the URL's org and app slugs as route segments. */
function pageFile(href: string): string {
  const route = href.split("#")[0].replace(/^\/o\/acme\/apps\/shop/, "/o/[org]/apps/[app]").replace(/^\/o\/acme/, "/o/[org]");
  return path.join(import.meta.dirname, "../../app", route, "page.tsx");
}

describe("navigation menu", () => {
  it("never links to a page that doesn't exist, for any role", () => {
    for (const role of ROLES) {
      for (const href of [...links(projectMenu(role, base)), ...links(settingsMenu(role, "acme", base))]) {
        expect(existsSync(pageFile(href)), `${role}: ${href}`).toBe(true);
      }
    }
  });

  it("keeps developer pages out of the main menu", () => {
    const main = links(projectMenu("owner", base));
    expect(main.some((h) => h.includes("/settings/dev-ops/") || h.includes("/settings/privacy"))).toBe(false);
    expect(projectMenu("owner", base).map((g) => g.label)).toEqual(["Overview", "Acquisition", "Activation", "Retention", "Revenue", "Attribution", "Reports", "Users", "Audiences", "Flows Lab", "A/B experiments", "Settings"]);
    expect(projectMenu("owner", base).find((g) => g.label === "Acquisition")?.beta).toBe(true);
    expect(labels(projectMenu("owner", base))).toContain("Attribution/Deep links");
    // Retention is a section: its curves, churn and RFM segments, behind the retention page's permission.
    const retention = projectMenu("owner", base).find((g) => g.label === "Retention")!;
    expect(retention.href).toBeUndefined();
    expect(retention.items.map((i) => [i.label, i.href])).toEqual([
      ["Retention curves", `${base}/analytics/retention`],
      ["Churn", `${base}/analytics/churn`],
      ["RFM segments", `${base}/analytics/rfm`],
    ]);
    for (const role of ROLES) {
      const items = projectMenu(role, base).find((g) => g.label === "Retention")?.items.length ?? 0;
      expect(items, role).toBe(can(role, "analytics.read") ? 3 : 0);
    }
    expect(labels(settingsMenu("owner", "acme", base)).filter((l) => !l.includes("/"))).toEqual(["You", "Workspace", "Project", "Dev Ops", "Security"]);
  });

  it("shows each role only what its permissions open", () => {
    const marketer = labels(projectMenu("marketer", base));
    expect(marketer).toContain("Flows Lab/Flows");
    expect(marketer).toContain("Users");
    const analyst = labels(projectMenu("analyst", base));
    expect(analyst).toContain("Users");
    expect(analyst).not.toContain("Flows Lab/Flows");
    expect(projectMenu("analyst", base).some((g) => g.label === "Flows Lab")).toBe(false);

    const devSettings = labels(settingsMenu("developer", "acme", base));
    expect(devSettings).toEqual(expect.arrayContaining(["Dev Ops/SDK & API keys", "Dev Ops/Webhooks", "Dev Ops/Debugger", "Workspace/API keys"]));
    expect(devSettings).not.toContain("Workspace/Billing & plan");
    const marketerSettings = labels(settingsMenu("marketer", "acme", base));
    expect(marketerSettings).not.toContain("Dev Ops/SDK & API keys");
    expect(marketerSettings).toContain("Dev Ops/Messaging channels");
    expect(labels(settingsMenu("owner", "acme", base))).toContain("Project/Privacy requests");

    // Viewer: reports, acquisition, attribution, people and audiences (read only); no engagement or workspace admin.
    expect(labels(projectMenu("viewer", base))).toEqual([
      "Overview",
      "Acquisition", "Acquisition/Overview", "Acquisition/CAC & LTV", "Acquisition/Sources & campaigns", "Acquisition/Ad spend",
      "Activation", "Retention", "Retention/Retention curves", "Retention/Churn", "Retention/RFM segments", "Revenue",
      "Attribution", "Attribution/Attribution report", "Attribution/Tracking links & QR", "Attribution/Deep links",
      "Reports", "Reports/Events & trends", "Reports/Funnels", "Reports/Dashboards", "Reports/Saved reports",
      "Users", "Audiences", "Settings",
    ]);
    const viewerSettings = labels(settingsMenu("viewer", "acme", base));
    expect(viewerSettings.filter((l) => !l.includes("/"))).toEqual(["You", "Workspace", "Project", "Dev Ops", "Security"]);
    // Dev Ops shows only the view-only attribution and deep link setup pages: no keys, debugger or webhooks.
    expect(viewerSettings.filter((l) => l.startsWith("Dev Ops/"))).toEqual(["Dev Ops/Deep link setup", "Dev Ops/Attribution setup", "Dev Ops/Postbacks", "Dev Ops/SKAdNetwork"]);
    expect(viewerSettings).toContain("You/Your profile");
    expect(viewerSettings).not.toContain("Workspace/API keys");
    expect(viewerSettings).toEqual(expect.arrayContaining(["Project/General", "Project/Environments", "Project/Timezone & currency"]));
    expect(viewerSettings).not.toContain("Workspace/Members & roles");
  });

  it("marks unbuilt pages as soon, without a link", () => {
    const soon = projectMenu("owner", base).flatMap((g) => g.items).filter((i) => i.soon);
    expect(soon.map((i) => i.label)).toEqual([]);
    expect(soon.every((i) => !i.href)).toBe(true);
  });

  it("leaves project groups out of workspace-only settings", () => {
    expect(settingsMenu("owner", "acme").map((g) => g.label)).toEqual(["You", "Workspace", "Security"]);
  });

  it("highlights the most specific entry", () => {
    const menu = projectMenu("owner", base);
    expect(activeHref(menu, base)).toBe(base);
    expect(activeHref(menu, `${base}/analytics`)).toBe(`${base}/analytics`);
    expect(activeHref(menu, `${base}/analytics/events`)).toBe(`${base}/analytics/events`);
    expect(activeHref(menu, `${base}/analytics/users/profile`)).toBe(`${base}/analytics/users`);
    expect(activeHref(menu, `${base}/growth/setup`)).toBe(`${base}/growth`);
    const settings = settingsMenu("owner", "acme", base);
    expect(activeHref(settings, `${base}/settings/dev-ops/implementation/questions`)).toBe(`${base}/settings/dev-ops/implementation/plan`);
    expect(activeHref(settings, `${base}/settings/dev-ops/attribution/skan`)).toBe(`${base}/settings/dev-ops/attribution/skan`);
    expect(activeHref(settings, "/o/acme/settings/billing")).toBe("/o/acme/settings/billing");
  });
});
