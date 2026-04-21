/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SCHEMA_VERSION: string;
    OBSERVER_TS_SKEW_SECS: string;
    ALLOWED_ORIGINS: string;
  }
}

declare module "*.sql?raw" {
  const contents: string;
  export default contents;
}
