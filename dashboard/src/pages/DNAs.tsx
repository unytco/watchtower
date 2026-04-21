import useSWR from "swr";
import { fetcher } from "../api";
import { useAppContext } from "../context";
import { labelForDna, relTime, truncHash } from "../lib/format";

interface Row {
  observer_id: string;
  dna_b64: string;
  dna_tag: string | null;
  last_seen_iso: string;
  first_seen_iso: string;
}

export function DNAs() {
  const { observerId } = useAppContext();
  const q = observerId ? `?observer_id=${encodeURIComponent(observerId)}` : "";
  const { data } = useSWR<{ dnas: Row[] }>(`/api/dnas${q}`, fetcher, {
    // Tolerate endpoint absence (worker currently exposes dnas via /search).
    onError: () => {},
    shouldRetryOnError: false,
  });

  const rows: Row[] = data?.dnas ?? [];
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">DNAs</h1>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">DNA</th>
              <th className="text-left px-3 py-2">Observer</th>
              <th className="text-left px-3 py-2">First seen</th>
              <th className="text-left px-3 py-2">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.observer_id}-${r.dna_b64}`} className="border-t border-border">
                <td className="px-3 py-2 mono">
                  {labelForDna(r.dna_tag, r.dna_b64)}
                  {r.dna_tag && (
                    <span className="text-muted ml-2 text-xs">{truncHash(r.dna_b64)}</span>
                  )}
                </td>
                <td className="px-3 py-2 mono text-xs">{r.observer_id}</td>
                <td className="px-3 py-2">{relTime(r.first_seen_iso)}</td>
                <td className="px-3 py-2">{relTime(r.last_seen_iso)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-muted" colSpan={4}>
                  No DNAs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Use <span className="mono">hc-watchtower tag set-dna &lt;hash&gt; &lt;tag&gt;</span> on an
        observer host to assign memorable labels.
      </p>
    </div>
  );
}
