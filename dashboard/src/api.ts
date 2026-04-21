import useSWR from "swr";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export const fetcher = async <T>(url: string): Promise<T> => {
  const resp = await fetch(`${BASE}${url}`);
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return (await resp.json()) as T;
};

export interface Observer {
  observer_id: string;
  last_seen_iso: string;
  last_collection_ms: number;
  uptime_s: number;
  schema_version: number;
  n_errors: number;
  is_healthy: number;
  binary_version: string;
}

export interface Agent {
  observer_id: string;
  dna_b64: string;
  agent_b64: string;
  agent_tag: string | null;
  first_seen_iso: string;
  last_seen_iso: string;
  action_count: number;
  warrants_issued: number;
  warrants_against: number;
}

export interface Warrant {
  observer_id: string;
  dna_b64: string;
  op_hash_b64: string;
  warrant_type: string;
  author_b64: string;
  target_b64: string;
  ts_iso: string;
}

export interface MetricPoint {
  observer_id: string;
  dna_b64: string;
  bucket_hour_iso: string;
  integration_rate: number;
  lag_p50_ms: number;
  lag_p99_ms: number;
  pending_backlog: number;
}

export function useObservers() {
  return useSWR<{ observers: Observer[] }>("/api/observers", fetcher, {
    refreshInterval: 30_000,
  });
}

export function useSummary(observerId?: string) {
  const q = observerId ? `?observer_id=${encodeURIComponent(observerId)}` : "";
  return useSWR<{ agents: number; warrants: number; dnas: number }>(
    `/api/summary${q}`,
    fetcher,
    { refreshInterval: 30_000 },
  );
}

export function useAgents(observerId?: string, dna?: string) {
  const params = new URLSearchParams();
  if (observerId) params.set("observer_id", observerId);
  if (dna) params.set("dna", dna);
  const q = params.toString() ? `?${params}` : "";
  return useSWR<{ agents: Agent[] }>(`/api/agents${q}`, fetcher);
}

export function useWarrants(observerId?: string) {
  const q = observerId ? `?observer_id=${encodeURIComponent(observerId)}` : "";
  return useSWR<{ warrants: Warrant[] }>(`/api/warrants${q}`, fetcher);
}

export function useMetrics(observerId?: string, dna?: string, hours = 24) {
  const params = new URLSearchParams({ hours: String(hours) });
  if (observerId) params.set("observer_id", observerId);
  if (dna) params.set("dna", dna);
  return useSWR<{ metrics: MetricPoint[] }>(`/api/metrics?${params}`, fetcher);
}

export function useDiff(since: string, observerId?: string) {
  const params = new URLSearchParams({ since });
  if (observerId) params.set("observer_id", observerId);
  return useSWR<{ since: string; observer_id?: string; changed: Record<string, number> }>(
    `/api/diff?${params}`,
    fetcher,
  );
}

export function useSearch(q: string) {
  return useSWR<{
    results: Array<{ kind: string; hash: string; dna_b64: string; observer_id: string; tag: string | null }>;
  }>(q ? `/api/search?q=${encodeURIComponent(q)}` : null, fetcher);
}
