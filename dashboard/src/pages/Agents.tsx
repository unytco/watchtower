import { useAgents } from "../api";
import { useAppContext } from "../context";
import { labelForAgent, labelForDna, relTime, truncHash } from "../lib/format";

export function Agents() {
  const { observerId } = useAppContext();
  const { data } = useAgents(observerId ?? undefined);
  const rows = data?.agents ?? [];
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Agents</h1>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Agent</th>
              <th className="text-left px-3 py-2">DNA</th>
              <th className="text-right px-3 py-2">Actions</th>
              <th className="text-right px-3 py-2">Warrants issued</th>
              <th className="text-right px-3 py-2">Warrants against</th>
              <th className="text-left px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.observer_id}-${r.dna_b64}-${r.agent_b64}`} className="border-t border-border">
                <td className="px-3 py-2 mono">
                  {labelForAgent(r.agent_tag, r.agent_b64)}
                  {r.agent_tag && (
                    <span className="text-muted ml-2 text-xs">{truncHash(r.agent_b64)}</span>
                  )}
                </td>
                <td className="px-3 py-2 mono text-xs">{labelForDna(null, r.dna_b64)}</td>
                <td className="px-3 py-2 text-right mono">{r.action_count.toLocaleString()}</td>
                <td className="px-3 py-2 text-right mono">{r.warrants_issued}</td>
                <td className="px-3 py-2 text-right mono">
                  <span className={r.warrants_against > 0 ? "text-danger" : ""}>
                    {r.warrants_against}
                  </span>
                </td>
                <td className="px-3 py-2">{relTime(r.last_seen_iso)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-muted" colSpan={6}>
                  No agents discovered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
