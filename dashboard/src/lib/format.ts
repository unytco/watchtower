import { formatDistanceToNow } from "date-fns";

export const HASH_PREFIX = "u";

export function truncHash(h: string | null | undefined, head = 5, tail = 5): string {
  if (!h) return "";
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/**
 * Prepend the Holochain multibase `u` prefix if it isn't there already.
 * Watchtower stores hashes in the bare 52-char base64url-no-pad form
 * (see watchtower/crates/core/src/tag.rs), but Holochain tools (and users)
 * expect the 53-char `u…` canonical form.
 */
export function prefixHash(value: string | null | undefined): string {
  if (!value) return "";
  return value.startsWith(HASH_PREFIX) ? value : HASH_PREFIX + value;
}

export function formatHash(value: string, head = 5, tail = 5): string {
  return truncHash(prefixHash(value), head, tail);
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

/**
 * Render an ISO timestamp in the browser's local timezone, compactly.
 * Used for the hourly bucket labels in sparklines and Metrics cards.
 */
export function formatBucketLocal(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function labelForAgent(tag: string | null | undefined, agent_b64: string): string {
  return tag && tag.length > 0 ? tag : formatHash(agent_b64);
}

export function labelForDna(tag: string | null | undefined, dna_b64: string): string {
  return tag && tag.length > 0 ? tag : formatHash(dna_b64);
}
