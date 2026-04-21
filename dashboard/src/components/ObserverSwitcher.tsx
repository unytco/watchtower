import { useObservers } from "../api";
import { useAppContext } from "../context";
import { relTime } from "../lib/format";

export function ObserverSwitcher() {
  const { observerId, setObserverId } = useAppContext();
  const { data } = useObservers();
  const observers = data?.observers ?? [];
  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="text-muted">Observer</label>
      <select
        className="bg-surface border border-border rounded px-2 py-1 mono text-xs"
        value={observerId ?? ""}
        onChange={(e) => setObserverId(e.target.value || null)}
      >
        <option value="">All observers</option>
        {observers.map((o) => (
          <option key={o.observer_id} value={o.observer_id}>
            {o.is_healthy ? "●" : "○"} {o.observer_id} · {relTime(o.last_seen_iso)}
          </option>
        ))}
      </select>
    </div>
  );
}
