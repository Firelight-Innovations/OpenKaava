import { useEffect, useId, useRef, useState } from "react";
import type { HoverCardProps } from "./types";
import "./meters.css";

/** How long the card stays after the pointer leaves, so it can cross into the card. */
const LINGER_MS = 150;

/**
 * A small button that shows a card while it is hovered or focused. The card
 * only informs: nothing in it takes focus, and Esc puts it away.
 */
export function HoverCard({ label, trigger, align = "end", children }: HoverCardProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A card opened by hover leaves focus where it was, so Esc is heard on the
  // whole document while it shows, not only on the button.
  useEffect(() => {
    if (!open) return;
    const away = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", away);
    return () => document.removeEventListener("keydown", away);
  }, [open]);

  const show = () => {
    window.clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), LINGER_MS);
  };

  return (
    <span className="at-hover" onPointerEnter={show} onPointerLeave={hide}>
      <button
        type="button"
        className="at-hover__trigger"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onFocus={show}
        onBlur={hide}
        onClick={show}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          // Esc also stops the turn from the composer; here it only closes.
          event.stopPropagation();
          setOpen(false);
        }}
      >
        {trigger}
      </button>
      <div
        id={id}
        role="tooltip"
        className={`at-hover__card at-hover__card--${align}`}
        data-open={open ? "" : undefined}
      >
        {children}
      </div>
    </span>
  );
}
