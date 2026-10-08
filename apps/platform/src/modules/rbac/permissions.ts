/**
 * The single source of truth for roles and permissions.
 *
 * Every authorization decision in the app goes through `can()` / `assertCan()`
 * in ./authorize.ts. Nothing else compares role names. The database copy
 * (platform.roles / permissions / role_permissions) is generated from this file
 * by `npm run db:seed-rbac` and a unit test fails if the two drift.
 */

export const PERMISSIONS = {
  "organization.read": "View organization details",
  "organization.update": "Edit organization settings",
  "organization.delete": "Delete the organization",
  "members.read": "View members",
  "members.invite": "Invite members",
  "members.update_role": "Change member roles",
  "members.remove": "Remove members",
  "billing.read": "View plan, usage and invoices",
  "billing.manage": "Change plan and payment details",
  "apps.read": "View apps and environments",
  "apps.create": "Create apps",
  "apps.update": "Edit apps and environments",
  "apps.delete": "Archive or delete apps",
  "credentials.read": "View SDK keys and API key metadata",
  "credentials.manage": "Create, rotate and revoke keys",
  "events.read": "View raw events and the event debugger",
  "implementation.read": "View questionnaire, tracking plan and validation",
  "implementation.edit": "Answer the questionnaire and edit draft tracking plans",
  "implementation.approve": "Approve and publish tracking plan versions",
  "implementation.mapping": "Accept or reject event mappings",
  "analytics.read": "View analytics, funnels and retention",
  "analytics.write": "Save analytics reports",
  "growth.read": "View growth definitions and growth state",
  "growth.write": "Edit growth definitions in the draft tracking plan",
  "users.read": "View end-user profiles",
  "attribution.read": "View attribution",
  "attribution.manage": "Configure attribution sources and campaigns",
  "deep_links.read": "View deep link settings",
  "deep_links.manage": "Configure deep link domains and app associations",
  "audiences.read": "View audiences",
  "audiences.manage": "Create and edit audiences",
  "automations.read": "View automations and runs",
  "automations.manage": "Create, edit and activate automations",
  "integrations.read": "View integrations",
  "integrations.manage": "Configure integrations",
  "webhooks.manage": "Configure webhooks",
  "privacy.manage": "Handle data export and deletion requests",
  "audit.read": "View the audit log",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = ["owner", "admin", "developer", "analyst", "marketer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, { name: string; description: string; rank: number }> = {
  owner: { name: "Owner", description: "Full access including billing, members and deletion.", rank: 100 },
  admin: { name: "Admin", description: "Full operational access except billing changes and deleting the organization.", rank: 80 },
  developer: { name: "Developer", description: "Apps, environments, SDK, keys, events, integrations and webhooks.", rank: 50 },
  analyst: { name: "Analyst", description: "Analytics, funnels, retention, audiences, attribution and users.", rank: 30 },
  marketer: { name: "Marketer", description: "Audiences, automations, campaigns, analytics, users and attribution.", rank: 30 },
  viewer: { name: "Viewer", description: "Read-only access to analytics, activation, audiences and users.", rank: 10 },
};

const read: Permission[] = ["organization.read", "members.read", "apps.read", "implementation.read"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  admin: ALL_PERMISSIONS.filter((p) => p !== "billing.manage" && p !== "organization.delete"),
  developer: [
    ...read,
    "apps.create",
    "apps.update",
    "credentials.read",
    "credentials.manage",
    "events.read",
    "implementation.edit",
    "implementation.approve",
    "implementation.mapping",
    "analytics.read",
    "growth.read",
    "growth.write",
    "users.read",
    "integrations.read",
    "integrations.manage",
    "webhooks.manage",
    "deep_links.read",
    "deep_links.manage",
  ],
  analyst: [...read, "events.read", "analytics.read", "analytics.write", "growth.read", "users.read", "attribution.read", "audiences.read", "audiences.manage", "deep_links.read"],
  marketer: [
    ...read,
    "analytics.read",
    "analytics.write",
    "growth.read",
    "users.read",
    "attribution.read",
    "attribution.manage",
    "deep_links.read",
    "audiences.read",
    "audiences.manage",
    "automations.read",
    "automations.manage",
    "integrations.read",
  ],
  // Read-only: sees reports and people, changes nothing and sees no keys, members or configuration.
  viewer: ["organization.read", "apps.read", "analytics.read", "growth.read", "users.read", "audiences.read"],
};

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
