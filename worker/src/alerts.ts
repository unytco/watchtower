import type { Env } from "./types";

export interface AlertRule {
  id: string;
  kind: "new_warrant" | "observer_silent" | "pending_backlog" | "chain_lock_expired";
  params: Record<string, string | number>;
  recipients: string[];
  enabled: boolean;
}

export async function loadRules(env: Env): Promise<AlertRule[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, kind, params_json, recipients_json, enabled FROM alert_rules WHERE enabled = 1",
  ).all<{
    id: string;
    kind: AlertRule["kind"];
    params_json: string;
    recipients_json: string;
    enabled: number;
  }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    params: JSON.parse(r.params_json),
    recipients: JSON.parse(r.recipients_json),
    enabled: r.enabled === 1,
  }));
}

/// Evaluate every rule. New firing => create one incident, notify once.
export async function evaluate(env: Env): Promise<void> {
  const rules = await loadRules(env);
  for (const rule of rules) {
    const hits = await detectHits(env, rule);
    for (const hit of hits) {
      await fireIncident(env, rule, hit);
    }
  }
}

interface Hit {
  entityKey: string;
  subject: string;
  body: string;
}

async function detectHits(env: Env, rule: AlertRule): Promise<Hit[]> {
  switch (rule.kind) {
    case "new_warrant": {
      const since = isoMinutesAgo(15);
      const { results } = await env.DB.prepare(
        `SELECT observer_id, dna_b64, op_hash_b64, author_b64, target_b64
         FROM warrants WHERE first_seen_at > ?`,
      )
        .bind(since)
        .all<{
          observer_id: string;
          dna_b64: string;
          op_hash_b64: string;
          author_b64: string;
          target_b64: string;
        }>();
      return results.map((r) => ({
        entityKey: r.op_hash_b64,
        subject: `[watchtower] new warrant in ${r.dna_b64.slice(0, 10)}…`,
        body:
          `A new warrant was sighted.\n\n` +
          `Observer: ${r.observer_id}\n` +
          `DNA:      ${r.dna_b64}\n` +
          `Op hash:  ${r.op_hash_b64}\n` +
          `Author:   ${r.author_b64}\n` +
          `Target:   ${r.target_b64}\n`,
      }));
    }
    case "observer_silent": {
      const maxSilentMin = Number(rule.params.max_silent_minutes ?? 120);
      const threshold = isoMinutesAgo(maxSilentMin);
      const { results } = await env.DB.prepare(
        `SELECT observer_id, last_seen_iso FROM observers WHERE last_seen_iso < ?`,
      )
        .bind(threshold)
        .all<{ observer_id: string; last_seen_iso: string }>();
      return results.map((r) => ({
        entityKey: r.observer_id,
        subject: `[watchtower] observer ${r.observer_id} is silent`,
        body: `Observer ${r.observer_id} last reported at ${r.last_seen_iso} (> ${maxSilentMin} min ago).`,
      }));
    }
    case "pending_backlog": {
      const threshold = Number(rule.params.threshold ?? 10_000);
      const { results } = await env.DB.prepare(
        `SELECT observer_id, dna_b64, pending_backlog, bucket_hour_iso
         FROM derived_metrics_ts
         WHERE pending_backlog > ?
         ORDER BY bucket_hour_iso DESC
         LIMIT 100`,
      )
        .bind(threshold)
        .all<{
          observer_id: string;
          dna_b64: string;
          pending_backlog: number;
          bucket_hour_iso: string;
        }>();
      return results.map((r) => ({
        entityKey: `${r.observer_id}:${r.dna_b64}:${r.bucket_hour_iso}`,
        subject: `[watchtower] pending backlog ${r.pending_backlog} in ${r.dna_b64.slice(0, 10)}…`,
        body: `Observer ${r.observer_id} dna ${r.dna_b64} saw pending backlog of ${r.pending_backlog} at ${r.bucket_hour_iso}.`,
      }));
    }
    case "chain_lock_expired": {
      const now = new Date().toISOString();
      const { results } = await env.DB.prepare(
        `SELECT observer_id, dna_b64, author_b64, subject_b64, expires_at_iso
         FROM chain_locks WHERE expires_at_iso < ?`,
      )
        .bind(now)
        .all<{
          observer_id: string;
          dna_b64: string;
          author_b64: string;
          subject_b64: string;
          expires_at_iso: string;
        }>();
      return results.map((r) => ({
        entityKey: `${r.observer_id}:${r.dna_b64}:${r.author_b64}:${r.subject_b64}`,
        subject: `[watchtower] chain lock past expiry`,
        body: `Observer ${r.observer_id} dna ${r.dna_b64} has a chain lock on ${r.author_b64}/${r.subject_b64} expired at ${r.expires_at_iso}.`,
      }));
    }
  }
}

async function fireIncident(env: Env, rule: AlertRule, hit: Hit): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT id FROM alert_incidents WHERE rule_id = ? AND entity_key = ? AND state = 'open' LIMIT 1`,
  )
    .bind(rule.id, hit.entityKey)
    .first<{ id: string }>();
  if (existing) return;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO alert_incidents (id, rule_id, entity_key, fired_at, last_notified_at, state)
     VALUES (?, ?, ?, ?, ?, 'open')`,
  )
    .bind(id, rule.id, hit.entityKey, now, now)
    .run();

  await sendEmail(env, rule.recipients, hit.subject, hit.body);
}

export async function sendEmail(
  env: Env,
  to: string[],
  subject: string,
  body: string,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERT_FROM_ADDRESS) {
    console.log("alerts disabled (missing RESEND_API_KEY/ALERT_FROM_ADDRESS)");
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.ALERT_FROM_ADDRESS,
      to,
      subject,
      text: body,
    }),
  });
  if (!resp.ok) {
    console.log("resend failed", resp.status, await resp.text());
  }
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}
