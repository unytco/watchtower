import { useCallback, useEffect, useId, useRef, useState } from "react";

export interface HelpTipProps {
  children: React.ReactNode;
  label?: string;
  placement?: "top" | "bottom";
  className?: string;
  iconClassName?: string;
}

/**
 * Small (i) affordance with a styled popover. Shows on hover, focus, and
 * click (the latter for touch). Closes on outside click, blur, or Escape.
 */
export function HelpTip({
  children,
  label = "What does this mean?",
  placement = "top",
  className = "",
  iconClassName = "",
}: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const popId = useId();

  const visible = open || hover || focus;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  return (
    <span
      ref={ref}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={visible}
        aria-describedby={visible ? popId : undefined}
        onClick={toggle}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        className={
          `inline-flex items-center justify-center w-4 h-4 rounded-full ` +
          `text-[10px] leading-none font-semibold ` +
          `border border-border text-muted hover:text-fg hover:border-muted ` +
          `focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ` +
          `${iconClassName}`
        }
      >
        i
      </button>
      {visible && (
        <span
          role="tooltip"
          id={popId}
          className={
            `absolute z-20 w-64 text-left ` +
            `bg-surface border border-border rounded shadow-lg p-3 ` +
            `text-xs text-fg leading-snug ` +
            (placement === "top"
              ? "bottom-full left-1/2 -translate-x-1/2 mb-2"
              : "top-full left-1/2 -translate-x-1/2 mt-2")
          }
        >
          {children}
        </span>
      )}
    </span>
  );
}
