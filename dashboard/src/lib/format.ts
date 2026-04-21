import { formatDistanceToNow } from "date-fns";

export function truncHash(h: string | null | undefined, head = 6, tail = 4): string {
  if (!h) return "";
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export function labelForAgent(tag: string | null | undefined, agent_b64: string): string {
  return tag && tag.length > 0 ? tag : truncHash(agent_b64);
}

export function labelForDna(tag: string | null | undefined, dna_b64: string): string {
  return tag && tag.length > 0 ? tag : truncHash(dna_b64);
}
