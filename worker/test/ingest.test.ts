import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import schemaSql from "../src/schema.sql?raw";
import {
  applySql,
  observerPayload,
  registerObserver,
  signedRequest,
  type SignedHeaders,
} from "./helpers";

const SECRET_HEX = "a".repeat(64);
const OBSERVER_ID = "test-observer";

async function applySchema() {
  await applySql(schemaSql);
  await registerObserver(OBSERVER_ID, SECRET_HEX);
}

function minimalPayload() {
  return observerPayload(OBSERVER_ID, new Date().toISOString());
}

function request(bodyObj: unknown, overrides: SignedHeaders = {}) {
  return signedRequest("/ingest", OBSERVER_ID, SECRET_HEX, bodyObj, overrides);
}

describe("/ingest", () => {
  beforeAll(async () => {
    await applySchema();
  });

  it("accepts a valid payload", async () => {
    const resp = await SELF.fetch(await request(minimalPayload()));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("rejects stale timestamp", async () => {
    const stale = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const resp = await SELF.fetch(await request(minimalPayload(), { ts: stale }));
    expect(resp.status).toBe(401);
  });

  it("rejects replayed nonce", async () => {
    const nonce = "fixed-nonce";
    await SELF.fetch(await request(minimalPayload(), { nonce }));
    const resp = await SELF.fetch(await request(minimalPayload(), { nonce }));
    expect(resp.status).toBe(409);
  });

  it("rejects bad signature", async () => {
    const resp = await SELF.fetch(await request(minimalPayload(), { sig: "deadbeef".repeat(8) }));
    expect(resp.status).toBe(401);
  });

  it("rejects unknown observer", async () => {
    const resp = await SELF.fetch(await request(minimalPayload(), { observer: "nobody" }));
    expect(resp.status).toBe(401);
  });
});
