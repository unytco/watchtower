import type { Env, BridgePayload } from "./types";

const MAX_BODY_BYTES = 64 * 1024; // Bridge payload is ~1 KB; cap well below /ingest's 5 MB.

export interface IngestHeaders {
  schemaVersion: string | null;
  observerId: string | null;
  ts: string | null;
  nonce: string | null;
  sig: string | null;
}

function readIngestHeaders(req: Request): IngestHeaders {
  return {
    schemaVersion: req.headers.get("x-watchtower-schema"),
    observerId: req.headers.get("x-watchtower-observer"),
    ts: req.headers.get("x-watchtower-ts"),
    nonce: req.headers.get("x-watchtower-nonce"),
    sig: req.headers.get("x-watchtower-sig"),
  };
}

/**
 * Verify HMAC + replay-protection + schema and return the parsed payload.
 * Reuses the `observer_secrets` and `ingest_nonces` tables shared with
 * the Holochain observer so a single registration step covers both.
 */
export async function verifyAndParseBridge(
  req: Request,
  env: Env,
): Promise<{ payload: BridgePayload } | Response> {
  const headers = readIngestHeaders(req);
  if (
    !headers.schemaVersion ||
    !headers.observerId ||
    !headers.ts ||
    !headers.nonce ||
    !headers.sig
  ) {
    return textResponse(400, "missing ingest headers");
  }

  // Bridge payloads carry their own schema_version independent from the
  // Holochain observer schema. We accept the current bridge schema
  // (v1) and forward-compatible any future bumps by rejecting unknown
  // versions cleanly.
  if (headers.schemaVersion !== "1") {
    return textResponse(
      409,
      `bridge schema mismatch: reporter=${headers.schemaVersion}, worker=1`,
    );
  }

  const ts = Date.parse(headers.ts);
  const skewMs = Number(env.OBSERVER_TS_SKEW_SECS) * 1000;
  if (!ts || Math.abs(Date.now() - ts) > skewMs) {
    return textResponse(401, "timestamp outside acceptable skew");
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return textResponse(413, `body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const digest = await sha256Hex(buf);
  const canonical = [headers.observerId, headers.ts, headers.nonce, digest].join("\n");

  const secretHex = await fetchObserverSecret(env, headers.observerId);
  if (!secretHex) {
    return textResponse(401, "unknown observer");
  }
  const ok = await hmacVerify(secretHex, canonical, headers.sig);
  if (!ok) {
    return textResponse(401, "bad signature");
  }

  const exists = await env.DB.prepare(
    "SELECT 1 FROM ingest_nonces WHERE nonce = ? LIMIT 1",
  )
    .bind(headers.nonce)
    .first();
  if (exists) {
    return textResponse(409, "replayed nonce");
  }
  await env.DB.prepare(
    "INSERT INTO ingest_nonces (nonce, observer_id, ts) VALUES (?, ?, ?)",
  )
    .bind(headers.nonce, headers.observerId, headers.ts)
    .run();

  let payload: BridgePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return textResponse(400, "invalid json");
  }

  if (payload.observer_id !== headers.observerId) {
    return textResponse(400, "observer_id body/header mismatch");
  }
  if (!payload.dna_b64 || typeof payload.dna_b64 !== "string") {
    return textResponse(400, "missing dna_b64");
  }
  if (!payload.self_health || !payload.backlog || !payload.throughput) {
    return textResponse(400, "missing required payload sections");
  }

  return { payload };
}

async function fetchObserverSecret(env: Env, observerId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_hex FROM observer_secrets WHERE observer_id = ? LIMIT 1",
  )
    .bind(observerId)
    .first<{ secret_hex: string }>();
  return row?.secret_hex ?? null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return hex(new Uint8Array(digest));
}

async function hmacVerify(
  secretHex: string,
  message: string,
  sigHex: string,
): Promise<boolean> {
  const keyBytes = fromHex(secretHex);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sigBytes = fromHex(sigHex);
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(message));
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain" },
  });
}
