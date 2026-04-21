import { useOutletContext } from "react-router-dom";
import { useDnaObservers } from "../../api";
import { relTime } from "../../lib/format";

type Ctx = { dna: string };

export function DnaObservers() {
  const { dna } = useOutletContext<Ctx>();
  const { data } = useDnaObservers(dna);
  const rows = data?.observers ?? [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Observers reporting this DNA: <span className="mono">{rows.length}</span>
      </p>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Observer</th>
              <th className="text-right px-3 py-2">Agents seen</th>
              <th className="text-right px-3 py-2">Actions reported</th>
              <th className="text-left px-3 py-2">DNA last seen</th>
              <th className="text-left px-3 py-2">Observer last seen</th>
              <th className="text-right px-3 py-2">Errors</th>
              <th className="text-left px-3 py-2">Version</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.observer_id} className="border-t border-border">
                <td className="px-3 py-2 mono">
                  <span
                    className={`inline-block w-2 h-2 rounded-full mr-2 ${
                      o.is_healthy ? "bg-ok" : "bg-danger"
                    }`}
                  />
                  {o.observer_id}
                </td>
                <td className="px-3 py-2 text-right mono">
                  {o.agents_seen.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right mono">
                  {o.actions_reported.toLocaleString()}
                </td>
                <td className="px-3 py-2">{relTime(o.dna_last_seen)}</td>
                <td className="px-3 py-2">{relTime(o.observer_last_seen)}</td>
                <td className="px-3 py-2 text-right mono">
                  <span className={(o.n_errors ?? 0) > 0 ? "text-danger" : ""}>
                    {o.n_errors ?? 0}
                  </span>
                </td>
                <td className="px-3 py-2 mono text-xs">
                  {o.binary_version ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted"
                  colSpan={7}
                >
                  No observers reporting this DNA yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
