/** Where media files live. Drivers are chosen by env (./index.ts); credentials stay on the server. */
export type StorageDriverName = "postgres" | "s3";

export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface StorageDriver {
  readonly name: StorageDriverName;
  put(key: string, bytes: Uint8Array, contentType: string, organizationId: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Removes the object; removing one that isn't there is not an error. */
  delete(key: string): Promise<void>;
}

export class StorageError extends Error {}
