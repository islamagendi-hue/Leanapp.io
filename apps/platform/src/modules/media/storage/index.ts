import "server-only";
import { mediaStorageConfig } from "./config";
import { postgresDriver } from "./postgres";
import { s3Driver } from "./s3";
import type { StorageDriver, StorageDriverName } from "./types";

export type { StorageDriver, StorageDriverName } from "./types";

let override: StorageDriver | null = null;
let s3: StorageDriver | null = null;

/** Test hook: route new uploads to this driver (null restores the env choice). */
export function setStorageDriverForTests(d: StorageDriver | null) {
  override = d;
}

/** The driver new uploads go to (MEDIA_STORAGE_DRIVER). */
export function uploadDriver(): StorageDriver {
  if (override) return override;
  const cfg = mediaStorageConfig(process.env);
  if (cfg.driver === "postgres") return postgresDriver;
  return (s3 ??= s3Driver(cfg.s3));
}

/** The driver an existing object was written with: switching drivers keeps old files readable. */
export function driverFor(name: StorageDriverName): StorageDriver {
  if (override && override.name === name) return override;
  if (name === "postgres") return postgresDriver;
  const cfg = mediaStorageConfig(process.env);
  if (cfg.driver !== "s3") throw new Error("This file is in S3-compatible storage, but MEDIA_STORAGE_DRIVER is no longer s3.");
  return (s3 ??= s3Driver(cfg.s3));
}
