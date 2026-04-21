import { useWarrants } from "../api";
import { useAppContext } from "../context";
import { labelForDna, relTime, truncHash } from "../lib/format";

export function Warrants() {
  const { observerId } = useAppContext();
  const { data } = useWarrants(observerId ?? undefined);
  const rows = data?.warrants ?? [];
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Warrants</h1>
      <p className="text-xs text-muted">
        Total in current scope: <span className="mono">{rows.length}</span>
      </p>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">DNA</th>
              <th className="text-left px-3 py-2">Author</th>
              <th className="text-left px-3 py-2">Target</th>
              <th className="text-left px-3 py-2">Sighted</th>
              <th className="text-left px-3 py-2">Op</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.op_hash_b64} className="border-t border-border">
                <td className="px-3 py-2">
                  <span className="chip">{r.warrant_type}</span>
                </td>
                <td className="px-3 py-2 mono text-xs">{labelForDna(null, r.dna_b64)}</td>
                <td className="px-3 py-2 mono text-xs">{truncHash(r.author_b64)}</td>
                <td className="px-3 py-2 mono text-xs">{truncHash(r.target_b64)}</td>
                <td className="px-3 py-2">{relTime(r.ts_iso)}</td>
                <td className="px-3 py-2 mono text-xs">{truncHash(r.op_hash_b64, 10, 6)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-muted" colSpan={6}>
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
