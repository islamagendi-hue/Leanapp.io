-- Viewer can read Acquisition and Attribution (src/modules/rbac/permissions.ts), so the public
-- demo's menu shows them. deep_links.read lets the Deep links and Tracking links pages show the
-- real link domain and what works. Still read-only: changing anything needs attribution.manage
-- or deep_links.manage, which Viewer doesn't have.
update platform.roles set description = 'Read-only access to analytics, activation, acquisition, attribution, audiences and user profiles.' where id = 'viewer';
insert into platform.role_permissions (role_id, permission_id) values
  ('viewer', 'attribution.read'),
  ('viewer', 'deep_links.read')
on conflict do nothing;
