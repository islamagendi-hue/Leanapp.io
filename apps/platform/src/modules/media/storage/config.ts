/**
 * Media storage settings from env (names only in docs/deployment.md). Pure.
 *   MEDIA_STORAGE_DRIVER         postgres (default) | s3
 *   MEDIA_S3_ENDPOINT            https endpoint of the S3-compatible service
 *   MEDIA_S3_REGION              signing region (R2: auto; Supabase: the project's region)
 *   MEDIA_S3_BUCKET              bucket name
 *   MEDIA_S3_ACCESS_KEY_ID       access key id
 *   MEDIA_S3_SECRET_ACCESS_KEY   secret
 *   MEDIA_S3_FORCE_PATH_STYLE    "false" for virtual-hosted buckets (default path style)
 */
import type { S3Config } from "./s3";

type Env = Record<string, string | undefined>;

export type MediaStorageConfig =
  | { driver: "postgres" }
  | { driver: "s3"; s3: S3Config };

export interface MediaStorageProblem {
  variable: string;
  problem: string;
}

export function mediaStorageProblems(env: Env): MediaStorageProblem[] {
  const out: MediaStorageProblem[] = [];
  const driver = env.MEDIA_STORAGE_DRIVER || "postgres";
  if (driver !== "postgres" && driver !== "s3") out.push({ variable: "MEDIA_STORAGE_DRIVER", problem: 'must be "postgres" or "s3"' });
  if (driver === "s3") {
    for (const v of ["MEDIA_S3_ENDPOINT", "MEDIA_S3_REGION", "MEDIA_S3_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY"]) {
      if (!env[v]) out.push({ variable: v, problem: "not set (MEDIA_STORAGE_DRIVER=s3)" });
    }
    if (env.MEDIA_S3_ENDPOINT && !/^https?:\/\//.test(env.MEDIA_S3_ENDPOINT)) out.push({ variable: "MEDIA_S3_ENDPOINT", problem: "is not a URL" });
  }
  return out;
}

export function mediaStorageConfig(env: Env): MediaStorageConfig {
  const problems = mediaStorageProblems(env);
  if (problems.length) throw new Error(`Media storage is misconfigured: ${problems.map((p) => `${p.variable} ${p.problem}`).join("; ")}`);
  if ((env.MEDIA_STORAGE_DRIVER || "postgres") === "postgres") return { driver: "postgres" };
  return {
    driver: "s3",
    s3: {
      endpoint: env.MEDIA_S3_ENDPOINT!,
      region: env.MEDIA_S3_REGION!,
      bucket: env.MEDIA_S3_BUCKET!,
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE !== "false",
    },
  };
}
