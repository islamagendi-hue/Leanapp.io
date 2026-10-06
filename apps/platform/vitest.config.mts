import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // "server-only" throws outside React Server Components; tests run in plain Node.
  "server-only": path.resolve(import.meta.dirname, "test/empty-module.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "../../sdks/javascript/src/**/*.test.ts"], exclude: ["**/*.int.test.ts"] } },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts", "test/**/*.int.test.ts"],
          setupFiles: ["test/setup-db.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
