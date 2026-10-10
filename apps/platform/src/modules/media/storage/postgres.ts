import "server-only";
import { withSystem } from "@/lib/db";
import type { StorageDriver, StoredObject } from "./types";

/**
 * Files in Postgres (platform.media_objects, bytea). The default: it needs no
 * other service, so development, tests and small deployments work out of the
 * box. Files are served by the app (authorized route, or the public /m/ route
 * for assets with a public link). Large libraries belong in object storage (S3 driver).
 */
export const postgresDriver: StorageDriver = {
  name: "postgres",
  async put(key, bytes, contentType, organizationId) {
    await withSystem((db) =>
      db.query(
        `insert into platform.media_objects (storage_key, organization_id, content_type, bytes) values ($1, $2, $3, $4)
         on conflict (storage_key) do update set content_type = excluded.content_type, bytes = excluded.bytes`,
        [key, organizationId, contentType, Buffer.from(bytes)],
      ),
    );
  },
  async get(key): Promise<StoredObject | null> {
    const row = await withSystem((db) => db.one<{ content_type: string; bytes: Buffer }>("select content_type, bytes from platform.media_objects where storage_key = $1", [key]));
    return row ? { bytes: new Uint8Array(row.bytes), contentType: row.content_type } : null;
  },
  async delete(key) {
    await withSystem((db) => db.query("delete from platform.media_objects where storage_key = $1", [key]));
  },
};
