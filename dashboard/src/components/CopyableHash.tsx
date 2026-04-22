import { useCallback, useState } from "react";
import { prefixHash, truncHash } from "../lib/format";

export interface CopyableHashProps {
  value: string;
  label?: string | null;
  head?: number;
  tail?: number;
  className?: string;
  mono?: boolean;
}

/**
 * Click-to-copy hash. Rendered as a span (not a button) so it's valid HTML
 * inside <a> wrappers used by DNA cards and table rows.
 */
export function CopyableHash({
  value,
  label,
  head = 5,
  tail = 5,
  className = "",
  mono = true,
}: CopyableHashProps) {
  const [copied, setCopied] = useState(false);
  // Always display and copy the Holochain-canonical `u<hash>` form.
  const prefixed = prefixHash(value);

  const copy = useCallback(async () => {
    if (!prefixed) return;
    try {
      await navigator.clipboard.writeText(prefixed);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prefixed;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // give up silently
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [prefixed]);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void copy();
    },
    [copy],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void copy();
      }
    },
    [copy],
  );

  const display =
    label && label.length > 0 ? label : truncHash(prefixed, head, tail);

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      title={copied ? "Copied!" : `${prefixed}\nclick to copy`}
      aria-label={`Copy ${prefixed}`}
      className={
        `group inline-flex items-center gap-1.5 max-w-full align-baseline ` +
        `cursor-pointer rounded px-1 -mx-1 hover:bg-border/60 ` +
        `focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ` +
        `${mono ? "mono" : ""} ${className}`
      }
    >
      <span className="truncate">{display}</span>
      <CopyIcon copied={copied} />
    </span>
  );
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0 text-ok"
      >
        <path
          d="M3 8.5l3 3 7-7"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0 text-muted opacity-0 group-hover:opacity-70 group-focus-visible:opacity-100 transition-opacity"
    >
      <rect
        x="5"
        y="5"
        width="8"
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M3 11V4.5A1.5 1.5 0 0 1 4.5 3H11"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
