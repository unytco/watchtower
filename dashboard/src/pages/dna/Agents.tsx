import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useDnaAgents } from "../../api";
import { labelForAgent, relTime } from "../../lib/format";
import { CopyableHash } from "../../components/CopyableHash";

type Ctx = { dna: string };

export function DnaAgents() {
  const { dna } = useOutletContext<Ctx>();
  const [perObserver, setPerObserver] = useState(false);
  const { data } = useDnaAgents(dna, { perObserver });
  const rows = data?.agents ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted">
          {rows.length.toLocaleString()}{" "}
          {perObserver ? "(observer, agent) pair" : "agent"}
          {rows.length === 1 ? "" : "s"} in scope
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={perObserver}
            onChange={(e) => setPerObserver(e.target.checked)}
          />
          Show per-observer rows
        </label>
      </div>

      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Agent</th>
              {perObserver && <th className="text-left px-3 py-2">Observer</th>}
              <th className="text-right px-3 py-2">Actions</th>
              {!perObserver && (
                <th className="text-right px-3 py-2">Observers</th>
              )}
              <th className="text-right px-3 py-2">Warrants issued</th>
              <th className="text-right px-3 py-2">Warrants against</th>
              <th className="text-center px-3 py-2">Closed</th>
              <th className="text-center px-3 py-2">Opened</th>
              <th className="text-left px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const key = perObserver
                ? `${r.observer_id}-${r.agent_b64}`
                : r.agent_b64;
              return (
                <tr key={key} className="border-t border-border">
                  <td className="px-3 py-2">
                    <CopyableHash
                      value={r.agent_b64}
                      label={labelForAgent(r.agent_tag, r.agent_b64)}
                    />
                    {r.agent_tag && (
                      <span className="ml-2 text-xs text-muted">
                        <CopyableHash value={r.agent_b64} />
                      </span>
                    )}
                  </td>
                  {perObserver && (
                    <td className="px-3 py-2 text-xs">
                      <CopyableHash value={r.observer_id ?? ""} />
                    </td>
                  )}
                  <td className="px-3 py-2 text-right mono">
                    {r.action_count.toLocaleString()}
                  </td>
                  {!perObserver && (
                    <td className="px-3 py-2 text-right mono">
                      {r.observer_count}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right mono">
                    {r.warrants_issued}
                  </td>
                  <td className="px-3 py-2 text-right mono">
                    <span
                      className={r.warrants_against > 0 ? "text-danger" : ""}
                    >
                      {r.warrants_against}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <MigrationMark on={r.chain_closed} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <MigrationMark on={r.opening_summary_present} />
                  </td>
                  <td className="px-3 py-2">{relTime(r.last_seen_iso)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-muted" colSpan={8}>
                  No agents discovered for this DNA yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Migration flags arrive as 0/1 from D1. A set flag shows a check; an unset one
// a muted dash, so a non-migrating fleet reads as a quiet column of dashes.
function MigrationMark({ on }: { on: number }) {
  return on ? (
    <span className="text-accent" title="yes">
      ✓
    </span>
  ) : (
    <span className="text-muted" title="no">
      –
    </span>
  );
}
