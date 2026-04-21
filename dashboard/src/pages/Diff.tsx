import { useMemo, useState } from "react";
import { useAppContext } from "../context";
import { useDiff } from "../api";

const PRESETS = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 360 },
  { label: "24 hours", minutes: 1440 },
];

export function Diff() {
  const { observerId } = useAppContext();
  const [minutes, setMinutes] = useState(60);
  const since = useMemo(
    () => new Date(Date.now() - minutes * 60 * 1000).toISOString(),
    [minutes],
  );
  const { data } = useDiff(since, observerId ?? undefined);
  const changed = data?.changed ?? {};

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Diff</h1>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">Window</span>
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
        <span className="text-muted ml-3">since {since}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(changed).map(([table, count]) => (
          <div key={table} className="bg-surface border border-border rounded p-3">
            <div className="text-xs text-muted mono">{table}</div>
            <div className="text-2xl font-semibold mt-1">{count.toLocaleString()}</div>
            <div className="text-xs text-muted">rows changed</div>
          </div>
        ))}
      </div>
    </div>
  );
}
