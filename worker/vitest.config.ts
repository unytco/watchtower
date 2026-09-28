import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => ({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2024-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            SCHEMA_VERSION: "1",
            OBSERVER_TS_SKEW_SECS: "300",
            ALLOWED_ORIGINS: "http://localhost:5173",
            TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
          },
        },
      },
    },
  },
}));
