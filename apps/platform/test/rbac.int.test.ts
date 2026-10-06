/**
 * The permission matrix in src/modules/rbac/permissions.ts must match the
 * database after every migration. 0002 seeded the first matrix; later
 * permissions are added by their own migrations, so the check runs against the
 * migrated schema rather than against 0002.
 */
import { describe, expect, it } from "vitest";
import { withSystem } from "@/lib/db";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "@/modules/rbac/permissions";

describe("RBAC matrix", () => {
  it("has every permission in code, and no others", async () => {
    const rows = await withSystem((db) => db.query<{ id: string }>("select id from platform.permissions"));
    expect(rows.map((r) => r.id).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  it("grants each role exactly the permissions in code", async () => {
    const rows = await withSystem((db) => db.query<{ role_id: string; permission_id: string }>("select role_id, permission_id from platform.role_permissions"));
    for (const role of ROLES) {
      expect(rows.filter((r) => r.role_id === role).map((r) => r.permission_id).sort(), role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
  });
});
