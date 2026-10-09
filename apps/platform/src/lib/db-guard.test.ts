import { describe, expect, it } from "vitest";
import { previewDatabaseBlock, previewDbBranches } from "./db-guard";

describe("previewDatabaseBlock", () => {
  it("never blocks production or local runs", () => {
    expect(previewDatabaseBlock({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" })).toBeNull();
    expect(previewDatabaseBlock({ VERCEL_ENV: "production" })).toBeNull();
    expect(previewDatabaseBlock({ VERCEL_ENV: "development", VERCEL_GIT_COMMIT_REF: "feature/x" })).toBeNull();
    expect(previewDatabaseBlock({})).toBeNull();
  });

  it("allows the staging branch preview by default", () => {
    expect(previewDatabaseBlock({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" })).toBeNull();
  });

  it("blocks other preview branches and previews without a branch", () => {
    for (const ref of ["claude/project-thread-x", "main", "staging-2", "", undefined]) {
      expect(previewDatabaseBlock({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: ref })).toMatch(/disabled on this Preview/);
    }
  });

  it("honours PREVIEW_DB_BRANCHES, trimming spaces", () => {
    const env = { VERCEL_ENV: "preview", PREVIEW_DB_BRANCHES: " staging , qa " };
    expect(previewDatabaseBlock({ ...env, VERCEL_GIT_COMMIT_REF: "qa" })).toBeNull();
    expect(previewDatabaseBlock({ ...env, VERCEL_GIT_COMMIT_REF: "feature" })).not.toBeNull();
    expect(previewDbBranches({ PREVIEW_DB_BRANCHES: "" })).toEqual(["staging"]);
    expect(previewDbBranches({ PREVIEW_DB_BRANCHES: " , " })).toEqual([]);
  });

  it("an explicitly empty list blocks every preview, including staging", () => {
    expect(previewDatabaseBlock({ VERCEL_ENV: "preview", PREVIEW_DB_BRANCHES: ",", VERCEL_GIT_COMMIT_REF: "staging" })).toMatch(/no branches/);
  });

  it("never includes the database URL", () => {
    const msg = previewDatabaseBlock({
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      DATABASE_URL: "postgresql://leanapp:s3cret@pooler.example.com:6543/postgres",
    });
    expect(msg).not.toContain("s3cret");
    expect(msg).not.toContain("pooler.example.com");
  });
});
