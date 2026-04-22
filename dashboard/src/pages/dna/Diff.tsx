import { useMemo, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import { useDiff } from "../../api";
import { HelpTip } from "../../components/HelpTip";
import { relTime } from "../../lib/format";

type Ctx = { dna: string };

const PRESETS = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 360 },
  { label: "24 hours", minutes: 1440 },
];

// Source of truth: watchtower/worker/src/routes.ts /diff handler and its
// countSince helper. Tables are split by whether the D1 schema carries a
// dna_b64 column — node-scoped tables cannot be filtered by DNA, so their
// counts reflect the whole observer host.
const DNA_SCOPED = [
  "dnas_seen",
  "agents_discovered",
  "warrants",
  "chain_locks",
  "validation_coverage",
  "scheduled_functions",
  "slice_hashes",
  "chain_summaries",
] as const;

const NODE_SCOPED = ["cap_grants", "blocks", "apps"] as const;

type TableName = (typeof DNA_SCOPED)[number] | (typeof NODE_SCOPED)[number];

const TABLE_INFO: Record<
  TableName,
  { label: string; help: ReactNode }
> = {
  dnas_seen: {
    label: "DNAs seen",
    help: (
      <div className="space-y-1.5">
        <div>An observer upserted its record for this DNA.</div>
        <div className="text-muted">
          Usually just means the observer reconnected to the cell and refreshed
          the <span className="mono">last_seen</span> timestamp.
        </div>
      </div>
    ),
  },
  agents_discovered: {
    label: "Agents",
    help: (
      <div className="space-y-1.5">
        <div>A new agent was seen, or an existing one's activity grew.</div>
        <div className="text-muted">
          Covers both freshly-discovered pubkeys and bumps to{" "}
          <span className="mono">action_count</span> on existing agents.
        </div>
      </div>
    ),
  },
  warrants: {
    label: "Warrants",
    help: (
      <div className="space-y-1.5">
        <div>The observer sighted a warrant op it hadn't seen before.</div>
        <div className="text-muted">
          Warrants are append-only on the DHT; a count here means propagation,
          not that an existing warrant changed.
        </div>
      </div>
    ),
  },
  chain_locks: {
    label: "Chain locks",
    help: (
      <div className="space-y-1.5">
        <div>A chain lock was granted, renewed or re-observed.</div>
        <div className="text-muted">
          Locks have an <span className="mono">expires_at</span> and churn
          naturally as cells acquire and release them.
        </div>
      </div>
    ),
  },
  validation_coverage: {
    label: "Validation coverage",
    help: (
      <div className="space-y-1.5">
        <div>
          A <span className="mono">receipt_count</span> ticked up for an op.
        </div>
        <div className="text-muted">
          Means another peer signed off on that op's validation — the DHT
          reached stronger consensus on its validity.
        </div>
      </div>
    ),
  },
  scheduled_functions: {
    label: "Scheduled functions",
    help: (
      <div className="space-y-1.5">
        <div>A cell registered a new scheduled zome call.</div>
        <div className="text-muted">
          Holochain's scheduler persists its queue; new rows appear when zome
          code schedules future work.
        </div>
      </div>
    ),
  },
  slice_hashes: {
    label: "Slice hashes",
    help: (
      <div className="space-y-1.5">
        <div>An observer published a new DHT arc slice hash.</div>
        <div className="text-muted">
          These summarise what each observer believes its arc looks like and
          power cross-observer divergence checks.
        </div>
      </div>
    ),
  },
  chain_summaries: {
    label: "Chain summaries",
    help: (
      <div className="space-y-1.5">
        <div>A per-agent chain summary (action count, last seen) changed.</div>
        <div className="text-muted">
          Usually means that agent authored more actions since the last
          snapshot.
        </div>
      </div>
    ),
  },
  cap_grants: {
    label: "Capability grants",
    help: (
      <div className="space-y-1.5">
        <div>A capability grant was issued, updated or revoked on this node.</div>
        <div className="text-muted">
          Node-scoped: the schema doesn't carry a DNA column here, so the count
          is for the whole observer host.
        </div>
      </div>
    ),
  },
  blocks: {
    label: "Blocks",
    help: (
      <div className="space-y-1.5">
        <div>A node-level block (peer or cell) was added or renewed.</div>
        <div className="text-muted">
          Node-scoped, not filtered by DNA.
        </div>
      </div>
    ),
  },
  apps: {
    label: "Apps",
    help: (
      <div className="space-y-1.5">
        <div>An installed hApp was installed, updated or cloned.</div>
        <div className="text-muted">
          Node-scoped, not filtered by DNA.
        </div>
      </div>
    ),
  },
};

export function DnaDiff() {
  const { dna } = useOutletContext<Ctx>();
  const [minutes, setMinutes] = useState(60);
  const [showEmpty, setShowEmpty] = useState(false);
  const since = useMemo(
    () => new Date(Date.now() - minutes * 60 * 1000).toISOString(),
    [minutes],
  );
  const { data } = useDiff(since, { dna });
  const changed = data?.changed ?? {};

  const dnaRows = DNA_SCOPED.map((t) => ({
    name: t,
    count: Number(changed[t] ?? 0),
  }))
    .filter((r) => showEmpty || r.count > 0)
    .sort((a, b) => b.count - a.count);

  const nodeRows = NODE_SCOPED.map((t) => ({
    name: t,
    count: Number(changed[t] ?? 0),
  }))
    .filter((r) => showEmpty || r.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-muted flex items-center gap-1.5">
            Window
            <HelpTip label="What does Activity mean?">
              <div className="space-y-1.5">
                <div>
                  Rows in watchtower's database that observers upserted during
                  this window.
                </div>
                <div className="text-muted">
                  Not a state diff — Holochain content is deterministic, but
                  the set of agents, warrants, locks and grants grows over
                  time, and observers refresh their snapshots on a schedule.
                  A count of <em>N</em> means "<em>N</em> rows were touched,"
                  not "<em>N</em> things changed meaning."
                </div>
              </div>
            </HelpTip>
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.minutes}
              onClick={() => setMinutes(p.minutes)}
              className={`chip ${
                p.minutes === minutes ? "border-accent text-accent" : ""
              }`}
            >
              {p.label}
            </button>
          ))}
          <span className="text-muted ml-3">
            since {relTime(since)}
          </span>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
            Show empty
          </label>
        </div>
      </section>

      <Section
        title="DNA activity"
        subtitle="Filtered to this DNA. A count reflects upserts the observers reported in the window."
        rows={dnaRows}
        empty="Nothing changed for this DNA in this window."
      />

      <Section
        title="Node activity"
        subtitle="These tables don't carry a DNA column in the schema, so the counts cover the whole observer host — not just this DNA."
        rows={nodeRows}
        dim
        empty="No node-level changes in this window."
      />
    </div>
  );
}

function Section({
  title,
  subtitle,
  rows,
  dim,
  empty,
}: {
  title: string;
  subtitle: string;
  rows: Array<{ name: TableName; count: number }>;
  dim?: boolean;
  empty: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={`text-sm font-semibold ${dim ? "text-muted" : ""}`}>
          {title}
        </h3>
        <p className="text-xs text-muted max-w-xl text-right">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <div className="border border-border rounded p-6 text-center text-xs text-muted">
          {empty}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {rows.map((r) => {
            const info = TABLE_INFO[r.name];
            return (
              <div
                key={r.name}
                className={`bg-surface border border-border rounded p-3 ${
                  dim ? "opacity-80" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted">{info.label}</div>
                  <HelpTip
                    label={`What does a ${info.label} change mean?`}
                    placement="bottom"
                  >
                    {info.help}
                  </HelpTip>
                </div>
                <div className="text-2xl font-semibold mt-1 mono">
                  {r.count.toLocaleString()}
                </div>
                <div className="text-xs text-muted mono">{r.name}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
