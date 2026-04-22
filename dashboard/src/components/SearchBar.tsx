import { useState } from "react";
import { useSearch } from "../api";
import { formatHash } from "../lib/format";

export function SearchBar() {
  const [q, setQ] = useState("");
  const { data } = useSearch(q.length >= 3 ? q : "");
  const results = data?.results ?? [];
  return (
    <div className="relative">
      <input
        className="bg-surface border border-border rounded px-2 py-1 mono text-xs w-64"
        placeholder="Search hash / tag"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.length >= 3 && results.length > 0 && (
        <div className="absolute right-0 mt-1 w-96 max-h-80 overflow-auto bg-surface border border-border rounded shadow-lg z-20">
          {results.map((r, i) => (
            <div
              key={`${r.kind}-${r.hash}-${i}`}
              className="px-3 py-2 text-xs border-b border-border last:border-b-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-muted uppercase">{r.kind}</span>
                <span className="text-muted">{r.observer_id}</span>
              </div>
              <div className="mono">
                {r.tag ? `${r.tag} · ` : ""}
                {formatHash(r.hash, 10, 6)}
              </div>
              <div className="mono text-muted">{formatHash(r.dna_b64, 10, 6)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
