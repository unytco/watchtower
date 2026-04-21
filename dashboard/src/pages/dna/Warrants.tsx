import { useOutletContext } from "react-router-dom";
import { useWarrants } from "../../api";
import { relTime, truncHash } from "../../lib/format";

type Ctx = { dna: string };

export function DnaWarrants() {
  const { dna } = useOutletContext<Ctx>();
  const { data } = useWarrants({ dna });
  const rows = data?.warrants ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Warrants in this DNA: <span className="mono">{rows.length}</span>
      </p>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">Author</th>
              <th className="text-left px-3 py-2">Target</th>
              <th className="text-left px-3 py-2">Sighted</th>
              <th className="text-left px-3 py-2">Observer</th>
              <th className="text-left px-3 py-2">Op</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.observer_id}-${r.op_hash_b64}`}
                className="border-t border-border"
              >
                <td className="px-3 py-2">
                  <span className="chip">{r.warrant_type}</span>
                </td>
                <td className="px-3 py-2 mono text-xs">
                  {truncHash(r.author_b64)}
                </td>
                <td className="px-3 py-2 mono text-xs">
                  {truncHash(r.target_b64)}
                </td>
                <td className="px-3 py-2">{relTime(r.ts_iso)}</td>
                <td className="px-3 py-2 mono text-xs">{r.observer_id}</td>
                <td className="px-3 py-2 mono text-xs">
                  {truncHash(r.op_hash_b64, 10, 6)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted"
                  colSpan={6}
                >
                  No warrants observed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
