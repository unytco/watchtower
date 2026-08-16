import useSWR from "swr";
import { fetcher } from "../api";
import { relTime } from "../lib/format";

interface Incident {
  id: string;
  rule_id: string;
  entity_key: string;
  fired_at: string;
  resolved_at: string | null;
  last_notified_at: string;
  state: string;
}
interface Rule {
  id: string;
  kind: string;
  params_json: string;
  recipients_json: string;
  enabled: number;
  created_at: string;
}

export function Alerts() {
  const { data: rules } = useSWR<{ rules: Rule[] }>("/api/alerts/rules", fetcher);
  const { data: incidents, mutate } = useSWR<{ incidents: Incident[] }>(
    "/api/alerts/incidents",
    fetcher,
    { refreshInterval: 30_000 },
  );

  async function resolve(id: string) {
    await fetch(`/api/alerts/incidents/${id}/resolve`, { method: "POST" });
    mutate();
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm text-muted uppercase tracking-wider mb-2">Incidents</h2>
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="text-left px-3 py-2">Rule</th>
                <th className="text-left px-3 py-2">Entity</th>
                <th className="text-left px-3 py-2">Fired</th>
                <th className="text-left px-3 py-2">State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(incidents?.incidents ?? []).map((i) => (
                <tr key={i.id} className="border-t border-border">
                  <td className="px-3 py-2 mono text-xs">{i.rule_id}</td>
                  <td className="px-3 py-2 mono text-xs">{i.entity_key}</td>
                  <td className="px-3 py-2">{relTime(i.fired_at)}</td>
                  <td className="px-3 py-2">
                    <span className={i.state === "open" ? "text-danger" : "text-muted"}>
                      {i.state}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {i.state === "open" && (
                      <button className="chip hover:bg-border" onClick={() => resolve(i.id)}>
                        Resolve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {(!incidents || incidents.incidents.length === 0) && (
                <tr>
                  <td className="px-3 py-6 text-center text-muted" colSpan={5}>
                    No incidents.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm text-muted uppercase tracking-wider mb-2">Rules</h2>
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface text-muted">
              <tr>
                <th className="text-left px-3 py-2">Kind</th>
                <th className="text-left px-3 py-2">Params</th>
                <th className="text-left px-3 py-2">Recipients</th>
                <th className="text-left px-3 py-2">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {(rules?.rules ?? []).map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2 mono text-xs">{r.kind}</td>
                  <td className="px-3 py-2 mono text-xs">{r.params_json}</td>
                  <td className="px-3 py-2 mono text-xs">{r.recipients_json}</td>
                  <td className="px-3 py-2">{r.enabled ? "yes" : "no"}</td>
                </tr>
              ))}
              {(!rules || rules.rules.length === 0) && (
                <tr>
                  <td className="px-3 py-6 text-center text-muted" colSpan={4}>
                    No rules configured. POST <span className="mono">/api/alerts/rules</span> to
                    create.
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
