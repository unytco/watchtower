import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SECRET_HEX = "a".repeat(64);
const OBSERVER_ID = "test-observer";

async function applySchema() {
  const sql = fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8");
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of statements) {
    // @ts-expect-error test binding
    await env.DB.exec(s);
  }
  // @ts-expect-error test binding
  await env.DB.prepare(
    "INSERT OR REPLACE INTO observer_secrets (observer_id, secret_hex, created_at) VALUES (?, ?, ?)",
  )
    .bind(OBSERVER_ID, SECRET_HEX, new Date().toISOString())
    .run();
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(d));
}

async function hmacHex(secretHex: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromHex(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return toHex(new Uint8Array(sig));
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function minimalPayload(): object {
  return {
    schema_version: 1,
    observer_id: OBSERVER_ID,
    collected_at: new Date().toISOString(),
    self_health: {
      uptime_s: 60,
      last_collection_ms: 100,
      n_errors_this_cycle: 0,
      binary_version: "test",
    },
    node: {
      conductor: {
        holochain_version: "0.4.0",
        admin_port: 8888,
        running_apps: 1,
        paused_apps: 0,
        disabled_apps: 0,
        nonce_count: 1,
        nonce_duplicate_count: 0,
      },
      dnas: [],
      apps: [],
      blocks: [],
    },
  };
}

async function signedRequest(bodyObj: unknown, overrides: Record<string, string> = {}) {
  const body = new TextEncoder().encode(JSON.stringify(bodyObj));
  const ts = overrides.ts ?? new Date().toISOString();
  const nonce = overrides.nonce ?? crypto.randomUUID();
  const digest = await sha256Hex(body.buffer);
  const sig = await hmacHex(SECRET_HEX, [OBSERVER_ID, ts, nonce, digest].join("\n"));
  return new Request("http://test/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-watchtower-schema": overrides.schema ?? "1",
      "x-watchtower-observer": overrides.observer ?? OBSERVER_ID,
      "x-watchtower-ts": ts,
      "x-watchtower-nonce": nonce,
      "x-watchtower-sig": overrides.sig ?? sig,
    },
    body,
  });
}

describe("/ingest", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("accepts a valid payload", async () => {
    const resp = await SELF.fetch(await signedRequest(minimalPayload()));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("rejects stale timestamp", async () => {
    const stale = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const resp = await SELF.fetch(await signedRequest(minimalPayload(), { ts: stale }));
    expect(resp.status).toBe(401);
  });

  it("rejects replayed nonce", async () => {
    const nonce = "fixed-nonce";
    await SELF.fetch(await signedRequest(minimalPayload(), { nonce }));
    const resp = await SELF.fetch(await signedRequest(minimalPayload(), { nonce }));
    expect(resp.status).toBe(409);
  });

  it("rejects bad signature", async () => {
    const resp = await SELF.fetch(
      await signedRequest(minimalPayload(), { sig: "deadbeef".repeat(8) }),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects unknown observer", async () => {
    const resp = await SELF.fetch(
      await signedRequest(minimalPayload(), { observer: "nobody" }),
    );
    expect(resp.status).toBe(401);
  });
});
