import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2024-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            SCHEMA_VERSION: "1",
            OBSERVER_TS_SKEW_SECS: "300",
            ALLOWED_ORIGINS: "http://localhost:5173",
          },
        },
      },
    },
  },
});
