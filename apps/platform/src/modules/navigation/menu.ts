import { msg } from "@/i18n/translate";
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
      { label: msg("Overview"), href: base, items: [] },
      {
        label: msg("Acquisition"),
        beta: true,
        items: pick(role, [
          { label: msg("Overview"), href: `${base}/acquisition`, perm: "attribution.read" },
          { label: msg("CAC & LTV"), href: `${base}/acquisition/channels`, perm: "attribution.read" },
          { label: msg("Sources & campaigns"), href: `${base}/acquisition/sources`, perm: "attribution.read" },
          { label: msg("Ad spend"), href: `${base}/acquisition/spend`, perm: "attribution.read" },
        ]),
      },
      { label: msg("Activation"), href: `${base}/growth`, perm: "growth.read", items: [] },
      {
        label: msg("Retention"),
        items: pick(role, [
          { label: msg("Retention curves"), href: `${base}/analytics/retention`, perm: "analytics.read" },
          { label: msg("Churn"), href: `${base}/analytics/churn`, perm: "analytics.read" },
          { label: msg("RFM segments"), href: `${base}/analytics/rfm`, perm: "analytics.read" },
        ]),
      },
      { label: msg("Revenue"), href: `${base}/analytics/revenue`, perm: "analytics.read", items: [] },
      {
        label: msg("Attribution"),
        beta: true,
        items: pick(role, [
          { label: msg("Attribution report"), href: `${base}/acquisition/attribution`, perm: "attribution.read" },
          { label: msg("Tracking links & QR"), href: `${base}/acquisition/links`, perm: "attribution.read" },
          { label: msg("Deep links"), href: `${base}/acquisition/deep-links`, perm: "attribution.read" },
        ]),
      },
      {
        label: msg("Reports"),
        items: pick(role, [
          { label: msg("Events & trends"), href: `${base}/analytics/events`, perm: "analytics.read" },
          { label: msg("Funnels"), href: `${base}/analytics/funnels`, perm: "analytics.read" },
          { label: msg("Dashboards"), href: `${base}/analytics/dashboards`, perm: "analytics.read" },
          { label: msg("Saved reports"), href: `${base}/analytics`, perm: "analytics.read" },
        ]),
      },
      { label: msg("Users"), href: `${base}/analytics/users`, perm: "users.read", items: [] },
      { label: msg("Audiences"), href: `${base}/engage/audiences`, perm: "audiences.read", items: [] },
      {
        label: msg("Flows Lab"),
        items: pick(role, [
          { label: msg("Campaigns"), href: `${base}/engage/campaigns`, perm: "automations.read" },
          { label: msg("Flows"), href: `${base}/engage/automations`, perm: "automations.read" },
          { label: msg("Templates"), href: `${base}/engage/email-templates`, perm: "automations.read" },
          { label: msg("Channels & delivery"), href: `${base}/engage/channels`, perm: "automations.read" },
        ]),
      },
      { label: msg("A/B experiments"), href: `${base}/engage/experiments`, perm: "automations.read", items: [] },
      { label: msg("Settings"), href: `${base}/settings`, items: [] },
    ],
    role,
  );
}

/**
 * Settings menu. You is the signed-in person's own profile; Workspace and Security belong to the
 * organization; Project and Dev Ops to the project at `base`, and are left out when there is no
 * project in view.
 */
export function settingsMenu(role: Role, org: string, base?: string): NavGroup[] {
  const ws = `/o/${org}/settings`;
  const devops = `${base}/settings/dev-ops`;
  return groups(
    [
      {
        label: msg("You"),
        items: pick(role, [
          { label: msg("Your profile"), href: `${ws}/profile`, perm: "organization.read" },
          { label: msg("Help & support"), href: `${ws}/support`, perm: "organization.read" },
        ]),
      },
      {
        label: msg("Workspace"),
        items: pick(role, [
          { label: msg("General"), href: ws, perm: "organization.read" },
          { label: msg("Members & roles"), href: `${ws}/members`, perm: "members.read" },
          { label: msg("API keys"), href: `${ws}/api-keys`, perm: "credentials.read" },
          { label: msg("Billing & plan"), href: `${ws}/billing`, perm: "billing.read" },
          { label: msg("Usage"), href: `${ws}/billing#usage`, perm: "billing.read" },
        ]),
      },
      ...(base
        ? [
            {
              label: msg("Project"),
              items: pick(role, [
                { label: msg("General"), href: `${base}/settings/project`, perm: "apps.read" },
                { label: msg("Environments"), href: `${base}/settings/project/environments`, perm: "apps.read" },
                { label: msg("Timezone & currency"), href: `${base}/settings/project/timezone`, perm: "apps.read" },
                { label: msg("Integrations"), href: `${base}/settings/integrations`, perm: "apps.read" },
                { label: msg("Data retention"), soon: true, perm: "apps.read" },
                { label: msg("Privacy requests"), href: `${base}/settings/privacy`, perm: "privacy.manage" },
                { label: msg("Consent"), href: `${base}/settings/privacy/consent`, perm: "privacy.manage" },
                { label: msg("Suppression list"), href: `${base}/settings/privacy/suppressions`, perm: "privacy.manage" },
              ]),
            },
            {
              label: msg("Dev Ops"),
              items: pick(role, [
                { label: msg("Get started"), href: `${devops}/get-started`, perm: "implementation.read" },
                { label: msg("Implementation"), href: `${devops}/implementation/plan`, match: `${devops}/implementation`, perm: "implementation.read" },
                { label: msg("Events"), href: `${devops}/events`, perm: "implementation.read" },
                { label: msg("Attributes"), href: `${devops}/attributes`, perm: "implementation.read" },
                { label: msg("SDK & API keys"), href: `${devops}/sdk`, perm: "credentials.read" },
                { label: msg("Debugger"), href: `${devops}/debugger`, perm: "events.read" },
                { label: msg("Webhooks"), href: `${devops}/webhooks`, perm: "webhooks.manage" },
                { label: msg("Deep link setup"), href: `${devops}/deep-links`, perm: "deep_links.read" },
                { label: msg("Attribution setup"), href: `${devops}/attribution`, perm: "attribution.read" },
                { label: msg("Postbacks"), href: `${devops}/attribution/postbacks`, sub: true, perm: "attribution.read" },
                { label: msg("SKAdNetwork"), href: `${devops}/attribution/skan`, sub: true, perm: "attribution.read" },
                { label: msg("Messaging channels"), href: `${devops}/channels`, perm: "integrations.read" },
              ]),
            },
          ]
        : []),
      {
        label: msg("Security"),
        items: pick(role, [
          { label: msg("Audit log"), href: `${ws}/audit`, perm: "audit.read" },
          { label: msg("Sessions"), href: `${ws}/profile#sessions`, perm: "organization.read" },
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
