import { can } from "@/modules/rbac/authorize";
import type { Permission, Role } from "@/modules/rbac/permissions";

/**
 * The product's information architecture, in one place.
 *
 * The main menu is for the people who run the product (founders, product, growth, marketing,
 * analysts). Everything technical lives under Settings → Dev Ops. Each entry is shown only when
 * the member's role can open the page behind it (the same permission the page itself checks).
 * Entries for pages that don't exist yet carry `soon` and no link, so the menu never leads to a
 * dead page.
 */
export interface NavItem {
  label: string;
  /** Absent for `soon` items. */
  href?: string;
  /** Highlight this item for any page under this path (defaults to href). */
  match?: string;
  soon?: boolean;
  /** Shown as a sub-entry of the item above it. */
  sub?: boolean;
}

export interface NavGroup {
  label: string;
  /** A group with an href and no items is a single top-level entry. */
  href?: string;
  match?: string;
  beta?: boolean;
  items: NavItem[];
}

type Entry = NavItem & { perm: Permission };

const pick = (role: Role, entries: Entry[]): NavItem[] =>
  entries.filter((e) => can(role, e.perm)).map(({ perm: _perm, ...item }) => item);

function groups(list: (NavGroup & { perm?: Permission })[], role: Role): NavGroup[] {
  return list
    .filter((g) => (g.perm ? can(role, g.perm) : true) && (g.href || g.items.length > 0))
    .map(({ perm: _perm, ...g }) => g);
}

/** Main menu of a project. `base` is the project's path, /o/{org}/apps/{app}. */
export function projectMenu(role: Role, base: string): NavGroup[] {
  return groups(
    [
      { label: "Overview", href: base, items: [] },
      {
        label: "Analytics",
        items: pick(role, [
          { label: "Events & trends", href: `${base}/analytics/events`, perm: "analytics.read" },
          { label: "Funnels", href: `${base}/analytics/funnels`, perm: "analytics.read" },
          { label: "Retention", href: `${base}/analytics/retention`, perm: "analytics.read" },
          { label: "Revenue", href: `${base}/analytics/revenue`, perm: "analytics.read" },
          { label: "Activation", href: `${base}/growth`, perm: "growth.read" },
          { label: "Dashboards", href: `${base}/analytics/dashboards`, perm: "analytics.read" },
          { label: "Saved reports", href: `${base}/analytics`, perm: "analytics.read" },
        ]),
      },
      { label: "Users", href: `${base}/analytics/users`, perm: "users.read", items: [] },
      { label: "Audiences", href: `${base}/engage/audiences`, perm: "audiences.read", items: [] },
      {
        label: "Engagement",
        items: pick(role, [
          { label: "Campaigns", href: `${base}/engage/campaigns`, perm: "automations.read" },
          { label: "Flows", href: `${base}/engage/automations`, perm: "automations.read" },
          { label: "Templates", href: `${base}/engage/email-templates`, perm: "automations.read" },
          { label: "Channels & delivery", href: `${base}/engage/channels`, perm: "automations.read" },
        ]),
      },
      {
        label: "Acquisition",
        beta: true,
        items: pick(role, [
          { label: "Overview", href: `${base}/acquisition`, perm: "attribution.read" },
          { label: "Sources & campaigns", soon: true, perm: "attribution.read" },
          { label: "Attribution", soon: true, perm: "attribution.read" },
          { label: "Tracking links & QR", href: `${base}/acquisition/links`, perm: "attribution.read" },
          { label: "Deep links", href: `${base}/acquisition/deep-links`, perm: "attribution.read" },
        ]),
      },
      { label: "Settings", href: `${base}/settings`, items: [] },
    ],
    role,
  );
}

/**
 * Settings menu. Workspace and Security belong to the organization; Project and Dev Ops to the
 * project at `base`, and are left out when there is no project in view.
 */
export function settingsMenu(role: Role, org: string, base?: string): NavGroup[] {
  const ws = `/o/${org}/settings`;
  const devops = `${base}/settings/dev-ops`;
  return groups(
    [
      {
        label: "Workspace",
        items: pick(role, [
          { label: "General", href: ws, perm: "organization.read" },
          { label: "Members & roles", href: `${ws}/members`, perm: "members.read" },
          { label: "Billing & plan", href: `${ws}/billing`, perm: "billing.read" },
          { label: "Usage", href: `${ws}/billing#usage`, perm: "billing.read" },
        ]),
      },
      ...(base
        ? [
            {
              label: "Project",
              items: pick(role, [
                { label: "General", href: `${base}/settings/project`, perm: "apps.read" },
                { label: "Environments", href: `${base}/settings/project/environments`, perm: "apps.read" },
                { label: "Timezone & currency", href: `${base}/settings/project/timezone`, perm: "apps.read" },
                { label: "Data retention", soon: true, perm: "apps.read" },
                { label: "Privacy requests", href: `${base}/settings/privacy`, perm: "privacy.manage" },
                { label: "Consent", href: `${base}/settings/privacy/consent`, perm: "privacy.manage" },
                { label: "Suppression list", href: `${base}/settings/privacy/suppressions`, perm: "privacy.manage" },
              ]),
            },
            {
              label: "Dev Ops",
              items: pick(role, [
                { label: "Get started", href: `${devops}/get-started`, perm: "implementation.read" },
                { label: "Implementation", href: `${devops}/implementation/plan`, match: `${devops}/implementation`, perm: "implementation.read" },
                { label: "Events", href: `${devops}/events`, perm: "implementation.read" },
                { label: "Attributes", href: `${devops}/attributes`, perm: "implementation.read" },
                { label: "SDK & API keys", href: `${devops}/sdk`, perm: "credentials.read" },
                { label: "Debugger", href: `${devops}/debugger`, perm: "events.read" },
                { label: "Webhooks", href: `${devops}/webhooks`, perm: "webhooks.manage" },
                { label: "Deep link setup", href: `${devops}/deep-links`, perm: "deep_links.read" },
                { label: "Attribution setup", href: `${devops}/attribution`, perm: "attribution.read" },
                { label: "Postbacks", href: `${devops}/attribution/postbacks`, sub: true, perm: "attribution.read" },
                { label: "SKAdNetwork", href: `${devops}/attribution/skan`, sub: true, perm: "attribution.read" },
                { label: "Messaging channels", href: `${devops}/channels`, perm: "integrations.read" },
              ]),
            },
          ]
        : []),
      {
        label: "Security",
        items: pick(role, [
          { label: "Audit log", href: `${ws}/audit`, perm: "audit.read" },
          { label: "Sessions", href: "/account#sessions", perm: "organization.read" },
        ]),
      },
    ],
    role,
  );
}

/**
 * The menu entry to highlight for `path`: the one whose path (match, else href without its
 * #fragment) is the longest prefix of it, so /analytics/events wins over /analytics.
 */
export function activeHref(menu: NavGroup[], path: string): string | undefined {
  let best: { href: string; len: number } | undefined;
  const consider = (href: string | undefined, match: string | undefined) => {
    if (!href) return;
    const m = match ?? href.split("#")[0];
    if ((path === m || path.startsWith(`${m}/`)) && (!best || m.length > best.len)) best = { href, len: m.length };
  };
  for (const g of menu) {
    consider(g.href, g.match);
    for (const i of g.items) consider(i.href, i.match);
  }
  return best?.href;
}
