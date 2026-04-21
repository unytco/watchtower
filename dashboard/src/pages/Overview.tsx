import { useAppContext } from "../context";
import { useObservers, useSummary } from "../api";
import { relTime } from "../lib/format";

export function Overview() {
  const { observerId } = useAppContext();
  const { data: obs } = useObservers();
  const { data: sum } = useSummary(observerId ?? undefined);
  const observers = obs?.observers ?? [];
  const scoped = observerId ? observers.filter((o) => o.observer_id === observerId) : observers;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Agents" value={sum?.agents ?? 0} />
        <Stat label="Warrants" value={sum?.warrants ?? 0} />
        <Stat label="DNAs" value={sum?.dnas ?? 0} />
      </div>

      <section>
        <h2 className="text-sm text-muted uppercase tracking-wider mb-2">Observers</h2>
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="text-left px-3 py-2">Observer</th>
                <th className="text-left px-3 py-2">Last seen</th>
                <th className="text-right px-3 py-2">Collection (ms)</th>
                <th className="text-right px-3 py-2">Errors</th>
                <th className="text-left px-3 py-2">Version</th>
              </tr>
            </thead>
            <tbody>
              {scoped.map((o) => (
                <tr key={o.observer_id} className="border-t border-border">
                  <td className="px-3 py-2 mono">
                    <span
                      className={`inline-block w-2 h-2 rounded-full mr-2 ${
                        o.is_healthy ? "bg-ok" : "bg-danger"
                      }`}
                    />
                    {o.observer_id}
                  </td>
                  <td className="px-3 py-2">{relTime(o.last_seen_iso)}</td>
                  <td className="px-3 py-2 text-right mono">{o.last_collection_ms}</td>
                  <td className="px-3 py-2 text-right">{o.n_errors}</td>
                  <td className="px-3 py-2 mono text-xs">{o.binary_version}</td>
                </tr>
              ))}
              {scoped.length === 0 && (
                <tr>
                  <td className="px-3 py-6 text-center text-muted" colSpan={5}>
                    No observers reporting yet. Start <span className="mono">hc-watchtower-observer</span>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface border border-border rounded p-4">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div className="text-3xl font-semibold mt-1">{value.toLocaleString()}</div>
    </div>
  );
}
