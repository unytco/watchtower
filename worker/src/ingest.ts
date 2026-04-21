import type { Env, IngestPayload } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB hard cap on the whole payload
const MAX_DNA_BYTES = 100 * 1024;
const MAX_ROWS_PER_TABLE = 10_000;

export interface IngestHeaders {
  schemaVersion: string | null;
  observerId: string | null;
  ts: string | null;
  nonce: string | null;
  sig: string | null;
}

export function readIngestHeaders(req: Request): IngestHeaders {
  return {
    schemaVersion: req.headers.get("x-watchtower-schema"),
    observerId: req.headers.get("x-watchtower-observer"),
    ts: req.headers.get("x-watchtower-ts"),
    nonce: req.headers.get("x-watchtower-nonce"),
    sig: req.headers.get("x-watchtower-sig"),
  };
}

export async function verifyAndParse(
  req: Request,
  env: Env,
): Promise<{ payload: IngestPayload; rawBytes: number } | Response> {
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
  if (headers.schemaVersion !== env.SCHEMA_VERSION) {
    return textResponse(
      409,
      `schema mismatch: observer=${headers.schemaVersion}, worker=${env.SCHEMA_VERSION}`,
    );
  }

  // Timestamp skew check.
  const ts = Date.parse(headers.ts);
  const skewMs = Number(env.OBSERVER_TS_SKEW_SECS) * 1000;
  if (!ts || Math.abs(Date.now() - ts) > skewMs) {
    return textResponse(401, "timestamp outside acceptable skew");
  }

  // Read body once and verify its digest+signature.
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

  // Replay protection.
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

  // Parse JSON.
  let payload: IngestPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return textResponse(400, "invalid json");
  }

  if (payload.observer_id !== headers.observerId) {
    return textResponse(400, "observer_id body/header mismatch");
  }

  // Per-DNA size enforcement.
  for (const dna of payload.node?.dnas ?? []) {
    const bytes = new TextEncoder().encode(JSON.stringify(dna)).byteLength;
    if (bytes > MAX_DNA_BYTES) {
      return textResponse(
        413,
        `dna ${dna.dna_b64} snapshot is ${bytes} bytes, exceeds ${MAX_DNA_BYTES}`,
      );
    }

    if (
      dna.agents.length > MAX_ROWS_PER_TABLE ||
      dna.warrants.length > MAX_ROWS_PER_TABLE ||
      dna.chain_summaries.length > MAX_ROWS_PER_TABLE
    ) {
      return textResponse(413, `too many rows for dna ${dna.dna_b64}`);
    }
  }

  return { payload, rawBytes: buf.byteLength };
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
