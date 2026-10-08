-- Viewer: a read-only role for analytics, activation and users (src/modules/rbac/permissions.ts).
-- Marketers can now open user profiles, as the approved role model asks.
insert into platform.roles (id, name, description, rank) values
  ('viewer', 'Viewer', 'Read-only access to analytics, activation and users.', 10)
on conflict (id) do update set name = excluded.name, description = excluded.description, rank = excluded.rank;
update platform.roles set description = 'Audiences, automations, campaigns, analytics, users and attribution.' where id = 'marketer';
insert into platform.role_permissions (role_id, permission_id) values
  ('viewer', 'organization.read'),
  ('viewer', 'apps.read'),
  ('viewer', 'analytics.read'),
  ('viewer', 'growth.read'),
  ('viewer', 'users.read'),
  ('marketer', 'users.read')
on conflict do nothing;
