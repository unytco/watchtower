# D1 storage

This spec defines how the Worker stores what observers and bridge reporters post. The goal: D1 and the Worker stay inside the Cloudflare Workers Free plan as the network grows. Every field the dashboard and the `/api/*` endpoints show stays derivable.

The rule the design follows: **a post writes one row per client, plus one row per DNA it reports**. The number of agents and the amount of change do not matter. D1 bills rows, not bytes, so everything an observer reports about a DNA goes into that DNA's row.

## Limits this design is held to

Workers Free plan, as published on 2026-09-28:

| Limit | Free plan | Source |
| --- | --- | --- |
| D1 rows written | 100,000 per day, reset at 00:00 UTC. Further writes fail until the reset. | [1] |
| D1 rows read | 5,000,000 per day. Further queries fail until the reset. | [1] |
| D1 storage | 500 MB per database, 5 GB per account. | [2] |
| D1 string, BLOB or row | 2,000,000 bytes. | [2] |
| D1 SQL statement text | 100,000 bytes. Bound values are not part of the text. | [2] |
| D1 bound parameters | 100 per statement. | [2] |
| D1 queries per Worker invocation | 50. One `batch()` is one query: production runs 320-statement batches on this account. | [2], observed |
| Workers requests | 100,000 per day. Beyond that, Cloudflare answers error 1027. | [4] |
| Workers CPU | 10 ms per HTTP request and per cron run. Cloudflare tolerates infrequent overruns only. | [4] |
| Subrequests | 50 per invocation. | [4] |
| Cron Triggers | 5 per account. This Worker uses 1. | [4] |
| Workers Logs | 200,000 events per day. | [3] |

How D1 counts rows [1]. The Worker's vitest D1 pool reports the same counts in `meta.rows_written` and `meta.rows_read`, and they matched production to the row on 2026-09-28:

- Row size never matters. A 100 KB row is one row.
- In a `WITHOUT ROWID` table, an insert, an update and a delete each cost 1 write.
- In a rowid table with a composite primary key, an insert costs 2 writes plus 1 per secondary index. An update of unindexed columns costs 1. A delete costs 1.
- An upsert whose `WHERE` refuses the update costs 0 writes and 1 read.
- Every `json_each` element counts as a row read. A join between two `json_each` tables has no index.

Sources, all retrieved 2026-09-28, with the "last updated" date of each page:

1. D1 pricing, 2026-04-21: https://developers.cloudflare.com/d1/platform/pricing/
2. D1 limits, 2026-04-21: https://developers.cloudflare.com/d1/platform/limits/
3. Workers pricing, 2026-08-28: https://developers.cloudflare.com/workers/platform/pricing/
4. Workers limits, 2026-09-05: https://developers.cloudflare.com/workers/platform/limits/
5. D1 batch transactions, 2026-06-22: https://developers.cloudflare.com/d1/worker-api/d1-database/
6. Workers KV limits, 2026-04-21: https://developers.cloudflare.com/kv/platform/limits/
7. Durable Objects pricing, 2026-08-25: https://developers.cloudflare.com/durable-objects/platform/pricing/
8. R2 pricing, 2026-08-07: https://developers.cloudflare.com/r2/pricing/
9. Cache API, 2026-08-14: https://developers.cloudflare.com/workers/runtime-apis/cache/
10. Workers Analytics Engine pricing and limits, 2026-04-23: https://developers.cloudflare.com/analytics/analytics-engine/pricing/
11. Workers Logs, 2026-08-11: https://developers.cloudflare.com/workers/observability/logs/workers-logs/

## Growth model

Notation:

- `O` observers. `D` DNAs in each observer post. `A` agents per observer and DNA. `B` bridge reporters.
- `p_o` observer posts per day, 86,400 divided by the interval: 288 at the deployed 300 s.
- `p_b` bridge posts per day: 1,440 at the default 60 s.
- Per post, for each observer and DNA: `a` agents whose counts, tag or flags changed. `s` slice hashes that changed. `v` ops new in the validation-coverage list.
- `m` is 1 for a post whose metrics differ from the stored hour, else 0.
- `β` and `τ` are 1 for a bridge post whose backlog or throughput numbers changed, else 0.

### The schema of migrations 0001 to 0007

Rows written per day:

```
W = O·p_o·(3 + D·(1 + A + 2a + s + 2v + m)) + 96·O·D + B·p_b·(3 + β + τ) + 96·B
```

- `3` per observer post: the replay nonce, its deletion by the cron, and the `observers` row.
- Per DNA: `1` for `dnas_seen`, `A` agent last-seen updates, `2a` for each changed agent's index write and chain summary, `2v` per new coverage op.
- `96` per series and day: a new hourly bucket costs 3 writes (table and two indexes), and its deletion 1, 24 times a day.
- Per bridge post: the nonce, its deletion, and the service row.

Production check: from 20:20 to 21:05 UTC on 2026-09-28, the database wrote 260 rows, which is 8,320 a day. The formula gives 8,256 for today's fleet.

| Scenario (1 observer, 1 DNA, 1 bridge unless stated) | Rows written per day |
| --- | --- |
| Today: 9 agents, quiet | 8,256 |
| 100 agents, quiet | 34,752 |
| 100 agents, 10 % of them active each post | 40,512 |
| 100 agents, all active each post | 92,352 |
| 300 agents, quiet | 92,352 |
| 100 agents, 50 new coverage ops each post | 63,552 |
| 2 observers, 100 agents, quiet | 65,088 |
| Migration window: 2 DNAs of 100 agents, quiet | 64,224 |

This schema crosses 100,000 rows a day at any of these:

- 327 quiet agents.
- 273 agents with 10 % active.
- 109 agents, all active.
- 161 quiet agents seen by two observers.

Reads grow with agents too:

- `/api/dnas` and `/api/dnas/:dna/summary` each read about 3 rows per stored agent: 306 at 100 agents.
- The dashboard polls them every 30 s, 2,880 times a day per open tab. One tab left open reads about 8,640·A rows a day.
- The 5,000,000 read limit falls at about 580 agents with one such tab, and at about 290 with two.
- The cron's retention delete on `bridge_throughput_ts` scans the whole table on every run, because no index leads with the hour. That is 644 rows per run today, and 207,000 a day at 30 days of retention.

CPU: each observer post builds about 330 statements. In production on 2026-09-28, observer posts used 17 to 46 ms of CPU, over the 10 ms limit on every post. Bridge posts used 3 to 4 ms.

### This design

```
W = O·(p_o·(1 + D) + 48·D) + B·(p_b + 48)
```

- `1` per post: the client row.
- `D` per observer post: one report row per DNA.
- `48` per series and day: each completed hour is written once, and deleted once 30 days later.

| Scenario | Rows written per day |
| --- | --- |
| Today's fleet, any number of agents, any churn | 2,112 |
| 2 DNAs, any agents, any churn | 2,448 |
| 2 observers, 1 DNA | 2,736 |
| 5 observers, 2 DNAs, 3 bridges | 9,264 |

Nothing in `W` depends on `A`, `a`, `s`, `v` or `m`. This design crosses 100,000 rows a day at any of these:

- 158 observers with 1 DNA and 1 bridge.
- 102 observers with 2 DNAs and 2 bridges.
- 67 bridge reporters posting every minute.

Reads:

- An observer post reads its client row and the report rows of the DNAs it posts: about `3 + D` plus the number of observers of each posted DNA.
- A bridge post reads about 3 rows.
- An endpoint the dashboard polls reads the rows of the clients and reports in its scope, and the hourly rows in its window. It never reads a row per agent.
- Today's fleet reads about 7,000 rows a day before any dashboard use.

## Design

### Tables

`ingest_clients` is `WITHOUT ROWID` with the key `client_id`. It holds one row per observer or bridge reporter with an accepted post.

| Column | Holds |
| --- | --- |
| `client_id` | The `x-watchtower-observer` header. |
| `kind` | `observer` or `bridge`, fixed by the first accepted post. |
| `last_ts_ms` | The signed `x-watchtower-ts` of the latest accepted post, in ms. |
| `last_seen_iso` | The `collected_at` of the latest accepted post. |
| `dna_b64` | For a bridge, the DNA it reports. For an observer, null. |
| `health` | JSON. Observer: `schema_version`, `uptime_s`, `last_collection_ms`, `n_errors`, `is_healthy` (1), `binary_version`. |
| `health`, bridge | Every `self_health` field. Booleans are 0 or 1. Absent `unclassified_*` fields are 0. |
| `node` | For an observer, JSON `{apps, blocks}`, two arrays of entries. For a bridge, null. |
| `backlog` | For a bridge, JSON of the backlog numbers plus `updated_at`, the last time a number changed. For an observer, null. |
| `hour_iso`, `succeeded`, `failed`, `avg_time_to_succeed_s` | For a bridge, the current hour's throughput, from its latest post. |

A trigger aborts any update that sets `last_ts_ms` without raising it, with the message `replayed timestamp`. A D1 batch is one transaction [5], so the abort undoes the whole post.

`dna_reports` is `WITHOUT ROWID` with the key `(dna_b64, observer_id)`. It holds one row per DNA an observer reports.

| Column | Holds |
| --- | --- |
| `dna_tag` | The latest post's `dna_tag`. |
| `first_seen_iso` | The `collected_at` of the first post that reported the DNA. |
| `last_seen_iso` | The `collected_at` of the latest post that reported it. |
| `written_at` | The Worker's clock at the latest write. |
| `agents_seen`, `actions_reported` | This observer's stored agent entries, and the sum of their `action_count`. |
| `dna_agents`, `dna_total_actions`, `dna_agents_closed`, `dna_agents_opened`, `dna_warrants` | The DNA-wide rollup across every report of the DNA, computed at this write. |
| `hour_iso`, `integration_rate`, `lag_p50_ms`, `lag_p99_ms`, `pending_backlog` | The current hour's metrics, from the latest post. Null is a degraded read. |
| `agents` | A JSON array of agent entries. |
| `warrants` | A JSON array of warrant entries. |
| `sections` | A JSON object. Arrays of entries: `chain_summaries`, `slice_hashes`, `chain_locks`, `scheduled_functions`, `validation_coverage`, `cap_grants`. One entry: `dna_definition`. |

`metric_hours` and `throughput_hours` are `WITHOUT ROWID` with the key `(bucket_hour_iso, dna_b64, observer_id)`. They hold completed hours only.

- `metric_hours` holds the four metrics.
- `throughput_hours` holds `succeeded`, `failed` and `avg_time_to_succeed_s`. Its `observer_id` is the reporter's client id.
- The key leads with the hour, so the retention delete reads only the rows it deletes.

These tables stay as they are: `observer_secrets`, `alert_rules`, `alert_incidents`, `agent_tags`, `dna_tags`. The schema has no other table.

### Entries

An entry is the item the client posted, as received, plus the Worker's stamps. The Worker keeps fields it does not know, and they count as content. An observer can therefore add a field without a Worker change.

| Entries | Key | Kept from first sight | Taken from every post, not content | Never lowered | Worker stamps |
| --- | --- | --- | --- | --- | --- |
| `agents` | `agent_b64` | `first_seen_iso` | `last_seen_iso` | `chain_closed`, `opening_summary_present` (0 or 1) | `updated_at` |
| `warrants` | `op_hash_b64` | `author_b64`, `target_b64`, `ts_iso` | | | `first_seen_at`, `updated_at` |
| `chain_summaries` | `agent_b64` | `first_ts_iso` | | | `updated_at`. `last_ts_iso` moves only with a change. |
| `slice_hashes` | `arc_start`, `arc_end`, `slice_index` | | | | `updated_at` |
| `chain_locks` | `author_b64`, `subject_b64` | | | | `updated_at` |
| `scheduled_functions` | `author_b64`, `zome`, `fn_name` | | | | `updated_at` |
| `validation_coverage` | `op_hash_b64` | | | | `updated_at` |
| `cap_grants` | `app_id`, `cell_b64`, `tag` (null as "") | | | | `updated_at` |
| `dna_definition` | One per report. | | | | `updated_at` |
| `apps`, in the client `node` | `app_id` | | | | `updated_at` |
| `blocks`, in the client `node` | `target_id`, `start_iso` | | | | `updated_at` |

Content is every field the row does not name. A warrant's `proof_summary` is stored as the JSON text `proof_summary_json`, the form the API returns.

A post merges into the stored entries by these rules:

1. A new key is stored as received, with `updated_at` set to `collected_at`. A new warrant also gets `first_seen_at` set to `collected_at`.
2. For a known key, a changed content field or a raised never-lowered field replaces the content and sets `updated_at` to `collected_at`.
3. For a known key with no such change, `updated_at` stays. A flag reported false after true stays true.
4. A stored entry the post does not list stays as it was. The observer trimmed it to fit its payload budget, or it left the observer's view.
5. The post's entries come first, in the post's order. Unlisted entries follow in their stored order.

### Report budget

After a merge, `agents`, `warrants` and `sections` together hold at most 262,144 bytes (256 KiB) of UTF-8 JSON.

- Over budget, the Worker removes unlisted entries, oldest `updated_at` first.
- It empties the sections in this order: `validation_coverage`, `slice_hashes`, `chain_locks`, `scheduled_functions`, `cap_grants`, `chain_summaries`, `agents`.
- Warrants and the entries the post lists are never removed.
- The Worker logs every removal with the DNA, the observer, the section and the count.
- A client's `node` holds at most 65,536 bytes. It is pruned the same way: `blocks` first, then `apps`.

Why 256 KiB:

- It is 2.5 times the observer's per-DNA payload cap of 100 KiB.
- It is far below the D1 row limit of 2 MB.
- It keeps the JSON work of a post inside the CPU limit, as "Where the free design stops" shows.

Nothing limits the stored size today. Tables grow without bound.

### Ingest

Both `/ingest` and `/ingest/bridge` handle a post in this order:

1. These checks stay as they are. Missing headers answer 400. A wrong schema version answers 409: `SCHEMA_VERSION` for `/ingest`, `1` for `/ingest/bridge`.
2. A timestamp outside `OBSERVER_TS_SKEW_SECS` answers 401. A body over 5 MB (observer) or 64 KB (bridge) answers 413. An unknown client or a bad signature answers 401.
3. The nonce header stays required, because the signature covers it. The Worker does not store it.
4. The Worker parses and checks the body before it writes anything. Invalid JSON answers 400. So does a body `observer_id` that differs from the header.
5. A missing section answers 400. An observer post needs `node.dnas`, `node.apps` and `node.blocks`. A bridge post needs `dna_b64`, `self_health`, `backlog` and `throughput`. Today a missing `node` fails later with 500, after the nonce is written.
6. A DNA over 100 KiB answers 413. So does a DNA with more than 10,000 agents, warrants or chain summaries.
7. A client id whose stored `kind` differs from the endpoint's answers 409 `client kind mismatch`. Nothing rejects this today.
8. The Worker reads the client row. For each posted DNA, it reads every report of that DNA: its own in full, and the other observers' `agents` and `warrants`.
9. One batch writes the post: the client row first, then one report row per posted DNA, then any completed hours.
10. For a post whose signed timestamp is not later than the stored `last_ts_ms`, the trigger aborts the batch. The Worker answers 409 `replayed timestamp`.
11. Any other batch failure answers 500 `persist failed`. In both failure cases, nothing is written.
12. Success answers 200 `{"ok":true}`.

Replay protection accepts a post only with all three of these:

- A valid signature.
- A timestamp within the skew window.
- A timestamp later than the last accepted post of the same client id, on either endpoint.

The effects:

- A replay is refused at any age.
- For a client whose clock steps backwards, posts are refused until its clock passes its last accepted post.
- The first post of a new client id is accepted.

### Hourly series

- A report holds its DNA's current metrics hour. A bridge client holds its current throughput hour. The hour of a post is the hour of its `collected_at`.
- A post in the stored hour replaces the stored values.
- A post in a later hour writes the stored values as that hour's row, in `metric_hours` or `throughput_hours`, in the same batch. Its own values become the current hour.
- For a bridge, a change of `dna_b64` also completes the stored hour, under the old DNA.
- A post in an earlier hour writes its values into that hour's row and leaves the current hour alone.
- A series' current hour never has a row. Readers return the rows plus the current hours, ordered by hour.
- Each hour holds the values of its last post, as today.

### Rollup

Every report write computes the rollup over all reports of the DNA. It takes the posting observer's merged entries and the other observers' stored entries:

- `dna_agents`: distinct `agent_b64`.
- `dna_total_actions`: the sum, over agents, of the largest `action_count` any observer reports.
- `dna_agents_closed`, `dna_agents_opened`: agents whose flag any observer set.
- `dna_warrants`: distinct `op_hash_b64`.

Readers take the rollup of the DNA's report with the latest `written_at`. Two observers can post the same DNA at the same moment. Each can then miss the other's change until its next post.

The agents endpoint builds its canonical list with the same union, in the Worker, from the reports' `agents` and `warrants`.

### Reads

What each endpoint derives, and what it costs. "Rows" means D1 rows read per call.

| Endpoint | Derivation | Rows |
| --- | --- | --- |
| `GET /api/observers` | Observer clients: `client_id` as `observer_id`, `last_seen_iso`, and the `health` fields. Ordered by id. | Observer clients. |
| `GET /api/dnas` | Per DNA, `dna_tag`: a `dna_tags` name beats the report's tag, and the largest across reports wins. `observer_count`: the reports. | All reports. |
| `GET /api/dnas`, continued | `agent_count`, `total_actions`, `warrant_count` from the rollup. `last_activity_iso`: the latest `last_seen_iso`. `first_seen_iso`: the earliest. | |
| `GET /api/dnas`, order | Latest activity first, 500 at most. | |
| `GET /api/dnas/:dna/summary` | `agents`, `total_actions`, `agents_closed`, `agents_opened`, `warrants` from the rollup. `observers`, `last_activity_iso`, `dna_tag` from the reports. | The DNA's reports. |
| `GET /api/dnas/:dna/observers` | Per report: `observer_id`. From the client: `is_healthy`, `n_errors`, `observer_last_seen`, `binary_version`. | The DNA's reports and their clients. |
| `GET /api/dnas/:dna/observers`, continued | From the report: `dna_first_seen`, `dna_last_seen`, `agents_seen`, `actions_reported`. Latest first. | |
| `GET /api/dnas/:dna/bridge`, `services` | Bridge clients of the DNA. `updated_at` is `last_seen_iso`, because a service changes on every post. | The DNA's bridge clients. |
| `GET /api/dnas/:dna/bridge`, `backlog` | The backlog JSON, with `collected_at` set to `last_seen_iso` and its own `updated_at`. | |
| `GET /api/dnas/:dna/bridge`, `throughput` | Rows and current hours in the window, oldest first. | Hourly rows in the window. |
| `GET /api/dnas/:dna/agents` | The union of the DNA's agent entries, per agent. Tag: an `agent_tags` name for that observer beats the entry's tag, and the largest wins. | The DNA's reports. |
| `GET /api/dnas/:dna/agents`, continued | The largest `action_count`. The number of reports that list it. The earliest `first_seen_iso` and the latest `last_seen_iso`. Flags any observer set. | |
| `GET /api/dnas/:dna/agents`, warrants | `warrants_issued` and `warrants_against`: distinct op hashes across the DNA's warrant entries, by author and by target. | |
| `GET /api/dnas/:dna/agents?per_observer=1` | One row per report and agent entry, with the entry's own fields. | The DNA's reports. |
| `GET /api/dnas/:dna/agents`, order | Closed first, then opened, then `action_count` descending. At most `limit` rows. | |
| `GET /api/warrants` | Warrant entries with `observer_id`, `dna_b64` and every stored field, filtered by `observer_id` and `dna`. Latest `ts_iso` first, at most `limit`. | One per warrant entry in scope. |
| `GET /api/metrics` | `metric_hours` rows and current hours in the window, filtered by `observer_id` and `dna`. Oldest first. | Hourly rows in the window and reports in scope. |
| `GET /api/diff`, `dnas_seen` | Reports whose `last_seen_iso` is at or after `since`. | Reports in scope. |
| `GET /api/diff`, DNA sections | For `agents_discovered`, `warrants`, `chain_summaries`, `slice_hashes`, `chain_locks`, `scheduled_functions`, `validation_coverage` and `cap_grants`: entries with `updated_at` at or after `since`. | One per entry in scope. |
| `GET /api/diff`, filters | DNA sections follow `observer_id` and `dna`. `blocks` and `apps` count `node` entries of the observer clients that match `observer_id`, never filtered by DNA. | |
| `GET /api/diff?table=` | Answers one of these names. Any other name answers 0. | |
| `GET /api/search` | Up to 100 matches for `q`: agent entries by `agent_b64` or `agent_tag`, warrant entries by op hash, author or target, reports by `dna_b64` or `dna_tag`. | One per entry. |
| `/api/alerts/*`, `/healthz` | Unchanged. | Unchanged. |

The dashboard polls five endpoints every 30 s: `observers`, `dnas`, `summary`, the DNA's `observers`, and `bridge`. None of them reads agent or warrant entries. The other endpoints read entries only for a view the user opens or a search the user types.

### Cron

Every 5 minutes, the cron:

- Deletes `metric_hours` and `throughput_hours` rows older than 30 days.
- Deletes bridge clients whose `last_seen_iso` is older than 14 days.
- Evaluates the enabled alert rules.

Alert rules:

- `new_warrant`: warrant entries with `first_seen_at` in the last 15 minutes.
- `observer_silent`: observer clients silent for longer than `max_silent_minutes`.
- `pending_backlog`: current hours and the last completed hour with `pending_backlog` above `threshold`. The entity key stays `observer:dna:hour`.
- `chain_lock_expired`: chain lock entries past their `expires_at_iso`, listed or not.

Each run stays within the 50-query and 50-subrequest limits, whatever the number of hits:

- It makes one D1 read per rule.
- It writes every incident it opens in one batch.
- It sends one email per rule, listing that run's new hits: the first 50 in full, the rest as a count.
- Today each hit costs two queries and one email.

A run with nothing expired and no rules writes nothing.

### Budgets

Each budget is testable with the vitest D1 pool, counting every statement, `first()` included:

- An observer post writes `1 + D` rows, for any number of agents and any churn. It writes 1 more row for each DNA whose hour it completes.
- A bridge post writes 1 row. It writes 1 more row for an hour it completes.
- A refused post writes nothing.
- No post and no polled endpoint reads a row per agent.
- In production, observer posts stay under 10 ms of CPU at the 99th percentile.

## What the dashboard and the API keep

Every endpoint keeps its path, parameters and response shape. Every field keeps its meaning, except for these changes:

1. **Capability grants are per DNA**. The observer reports them per DNA, and the Worker stores them in the DNA's report. Their Activity count follows the DNA filter, under DNA activity. Today the Worker stores them per observer, and grants with one tag in two DNAs share one row.
2. **Warrants are stored per observer and DNA**. One observer can report one op hash under two DNAs. That gives two entries. Today it is one row, keyed by observer and op hash, with the first DNA.
3. **Unlisted entries stay until the report budget removes them**. A removed entry no longer counts anywhere: not in Activity, rollups or search.
4. **`pending_backlog` looks at the current and the last completed hour**. A new rule does not fire for older hours still in retention.
5. **Each rule sends one alert email per cron run**, listing the run's new hits. Today each hit sends its own email. Production has no rule configured.
6. **A replay is refused at any age**, with 409 `replayed timestamp`. Today the text is `replayed nonce`, and the refusal covers only a 10-minute window. A client whose clock steps backwards is refused until its clock passes its last accepted post.
7. **DNA-wide counts can lag one post interval**. This applies to the DNA list and the summary tiles, for two observers that post the same DNA at the same moment.
8. **Search results within one kind can come back in a different order**.

These meanings stay exactly as they are:

- `updated_at` moves only on a content change.
- "DNAs seen" moves on every post.
- An agent's last-seen is the latest post that listed it.
- First-seen values carry over from the current tables.
- An hourly point holds the last post of that hour.
- Degraded reads stay null.

The dashboard's Activity tab moves capability grants to DNA activity. Its help texts stop naming tables and columns that no longer exist.

## Alternatives rejected

| Option | What decides it | Verdict |
| --- | --- | --- |
| Workers KV for liveness | 1,000 writes a day, and 1 write per second per key [6]. | One bridge posts 1,440 times a day. |
| A Durable Object with SQLite storage | 100,000 requests a day. Rows written are billed as in D1. In-memory state is lost on eviction [7]. | Same row billing as D1, plus a Durable Object request per post. No gain over packing in D1. |
| An R2 object per client | 1,000,000 Class A operations a month, about 33,000 a day [8]. | Fewer writes than D1, and no query layer. |
| Cache API | Per data center, not replicated, and evictable [9]. | The ingest and the dashboard run in different data centers. |
| Workers Analytics Engine for hourly series | 100,000 data points and 10,000 read queries a day. 3-month retention. SQL over HTTP with an API token [10]. | Hourly rows in D1 cost 48 writes a day per series. |
| Last-seen written at most every N minutes | Last-seen precision drops to N minutes. | Packing makes last-seen free. An active network changes content on every post anyway. |
| Skip unchanged reports, with DNA last-seen on the client row | Saves `D` writes per post, on an idle network only. | A second home for DNA liveness, with no gain on a busy network. |
| Longer post intervals, or clients batching posts | Writes scale with posts. Freshness drops. | Not needed. It stays an operator knob: the observer's `interval_sec`, the bridge's `WATCHTOWER_REPORT_INTERVAL_MS`. |
| One row per observer, holding every DNA | The 2 MB row limit. | One write per post instead of `1 + D`. But the row grows with `D`, and a read of one DNA loads all of them. |
| Stamps merged in SQL with `json_each` | 5,000,000 rows read a day. | Every element is a row read, and the join is quadratic. |
| Nonce rows in a `WITHOUT ROWID` table | Two writes per post: the insert and the cron delete. | The client row already carries the timestamp guard at no extra write. |

## Where the free design stops

These limits come in the order the network reaches them:

1. **The observer's own per-DNA cap, 100 KiB**. It is `MAX_DNA_SNAPSHOT_BYTES` in `crates/core/src/lib.rs` and `MAX_DNA_BYTES` in the Worker.
   - Past it, the observer halves slice hashes, then capability grants, coverage, chain summaries, agents and warrants, until the DNA fits.
   - With 229 slice hashes and 50 coverage entries, a DNA is complete up to about 160 agents. The observer drops agents themselves from between 200 and 330.
   - This is not a Cloudflare limit. This design keeps every entry an observer ever listed. Open decision 4 covers the cap.
2. **Workers CPU, 10 ms per request**. A post's CPU grows with the JSON it parses and writes: the payload, the stored reports, other observers' agents and warrants, and the new reports.
   - Merging measured about 2.5 ms per MB of that JSON, in V8 on a workstation. This spec assumes 5 ms per MB in production, on top of the 3 to 4 ms a bridge post already uses.
   - Today a post handles about 100 KB of JSON. At the 100 KiB payload cap with a full 256 KiB report, it handles about 600 KB, near 7 ms in total.
   - The limit falls at about 1.4 MB of JSON per post. That allows a payload cap about 2 to 2.5 times today's, with the report budget scaled to match.
3. **Workers requests, 100,000 a day**. The total is posts, cron runs and dashboard polling.
   - Posts: 288 per observer and 1,440 per bridge.
   - Cron runs: 288. Cloudflare's docs do not say whether cron runs count, so this model counts them.
   - Polling: about 5,760 requests a day per tab left open. Today's fleet leaves room for about 17 such tabs.
4. **D1 rows written, 100,000 a day**. The limit falls at about 100 to 160 observers, or 67 bridge reporters.
5. **D1 rows read, 5,000,000 a day**. A tab left open reads about 86,000 rows a day, so the limit falls at around 50 such tabs.
6. **D1 storage, 500 MB**. A report holds at most 256 KiB, and an hourly series about 36 KB. 100 observer and DNA pairs need about 30 MB.

### Against Workers Paid

Workers Paid costs at least $5 a month [3]. It includes:

- 10 million requests, and 30 million CPU ms with up to 5 minutes per request.
- 25 billion D1 rows read, 50 million D1 rows written (about 1.67 million a day) and 5 GB of storage [1].
- Beyond these: $1.00 per million rows written, $0.001 per million read, $0.30 per million requests, $0.02 per million CPU ms.

Compared:

- **The current schema on Paid** stays inside the included writes up to about 5,800 quiet agents or 1,900 fully active ones per observer. An observer cannot report that many. Paid also removes the CPU limit that today's observer posts already exceed. It fixes both problems for $5 a month, with no engineering.
- **This design on Free** costs nothing. It has more than 40 times today's write volume in reserve. It stops at the limits above, and the first of them is the observer's own cap.
- **This design on Paid** reaches none of the limits above, at any network size this project plans for.

## Migration

### Rollout

1. Migration `0008` creates `ingest_clients` with its trigger, `dna_reports`, `metric_hours` and `throughput_hours`. It fills them from the current tables and leaves those untouched.
   - Clients come from `observers`, with `apps` and `blocks`. Bridge clients come from `bridge_services`, with `bridge_backlog` and the reporter's latest `bridge_throughput_ts` hour.
   - An id in both keeps the observer kind. `last_ts_ms` is the client's latest `ingest_nonces.ts`, or 0.
   - Reports come from `dnas_seen`, with every section's rows, their stamps and their first-seen values. Each observer's `cap_grants` go into each of its reports.
   - The migration computes each report's rollup and counts. The current hour is the latest `derived_metrics_ts` hour.
   - Hourly rows come from `derived_metrics_ts` and `bridge_throughput_ts`, except each series' current hour.
2. Before the deploy, save the JSON of every `GET /api/*` endpoint for the live DNA, and note D1's hourly rows written.
3. `make deploy-worker` applies `0008`, then deploys the Worker. The new Worker reads and writes only the new tables.
4. Deploy the dashboard's Activity changes after the Worker.
5. Check the first full hour:
   - About 88 rows written per hour with today's fleet, 2,112 a day.
   - Observer posts under 10 ms of CPU at the 99th percentile, in Workers analytics.
   - The saved responses match, apart from the meaning changes above and time-dependent values.
   - Observers and the bridge get 200.
6. Migration `0009` drops every table of migrations 0001 to 0007 that is not kept. It ships after at least 24 hours of passing checks, with its own approval, through `make deploy-worker`.

The previous Worker can accept posts between `0008` and the deploy. Those reach only the old tables. The next post carries the full latest state, so only that minute's hourly values are lost. A signed request from that minute, replayed before its client's next post, is accepted once.

### Rollback

- Before `0009`: `wrangler rollback` restores the previous Worker on the old tables, frozen at the cutover.
  - Its next posts refresh the latest state.
  - Hourly points and Activity stamps from the new Worker stay in the new tables, unseen.
  - A later deploy of the new Worker resumes from the new tables. Changes made in between show up as changes at that moment.
- After `0009`: restore D1 with Time Travel to a moment before `0009`, then run `wrangler rollback`. Free keeps 7 days of Time Travel. Everything written after that moment is lost.

### Compatibility

- Deployed observers and bridge reporters need no change: ingest schema 1, the same headers, the same bodies, the same success response.
- Refusals keep their status codes. Only the replay text changes.
- Fields added to payload items are stored without a Worker change.
- The automation's registration SQL on `observer_secrets` is unaffected.

## Open decisions

1. **Replay protection by timestamp instead of stored nonces**.
   - Option (a): refuse any post not later than its client's last accepted one, as specified.
   - Option (b): keep a nonce table, at 2 more writes per post.
   - Recommendation: (a). It saves 2 writes per post and refuses replays at any age. It touches ingest authentication, so a security review of this section comes before the build.
   - Settling it: (b) changes the Ingest and Tables sections of this spec.
2. **What happens to entries an observer stops listing**.
   - Option (a): keep them until the 256 KiB budget removes the oldest, as specified.
   - Option (b): also drop any unlisted entry unchanged for 30 days. Reports stay smaller, but `/api/diff` windows longer than 30 days lose those entries.
   - Option (c): never drop them. A 2 MB row cannot hold that.
   - Recommendation: (a). Until the budget binds, it stores exactly what the current tables store.
   - Settling it: the Report budget section of this spec, and the budget constant in the Worker.
3. **Stay on Workers Free with this design, or move to Workers Paid**.
   - Option (a): build this design and stay on Free.
   - Option (b): move to Paid only, and keep the current schema.
   - Option (c): both.
   - Recommendation: (a). It removes today's CPU overrun and the growth in writes and reads, at no running cost. Option (b) stays the fallback.
   - Settling it: no file. The plan changes in the Cloudflare dashboard.
4. **The observer's 100 KiB per-DNA cap**.
   - Option (a): leave it. The observer then trims agents past about 160 per DNA.
   - Option (b): raise it, with a more compact payload, in its own lane, once a DNA nears 120 agents.
   - Recommendation: (b), as separate work. The CPU limit allows a cap about 2 to 2.5 times today's. Production CPU figures from this design set the exact cap, and the report budget moves with it.
   - Settling it: `MAX_DNA_SNAPSHOT_BYTES` in `crates/core/src/lib.rs`, `MAX_DNA_BYTES` in `worker/src/ingest.ts`, and the Report budget section of this spec.
