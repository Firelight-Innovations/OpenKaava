/**
 * The shell's one modal primitive: `.k-dialog-scrim`/`.k-dialog` (§4's
 * Dialog row — `radius-xl`, `shadow-overlay`, `bg-layer-2`, see
 * `src/kaava-ui.css`) plus a focus trap and Escape-or-scrim-click to cancel.
 * Everything the New Cluster dialog (board 04) and the Switch Project
 * dialog (board 08) both need — see `apps/home/ui/src/WorktreeDialog.tsx`
 * for the pattern this generalizes (scrim, focus trap, Esc, `role="dialog"`),
 * rebuilt shell-side since an app cannot import from `src/shell/**`.
 *
 * Deliberately just the frame. What goes inside — a form, a list, two steps
 * — is the caller's; this component never reads `children` for content, only
 * for what to trap focus inside.
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { instant, instantOut, popover } from "../motion";
import "./dialogs.css";

export interface DialogProps {
  /** `aria-label` for the dialog's `role="dialog"` element. Every caller
   *  passes one — a dialog with no name is not something a screen reader
   *  can announce meaningfully when it opens. */
  label: string;
  /** Panel content. */
  children: ReactNode;
  /** Escape, or a pointerdown on the scrim itself, both call this. Every
   *  caller treats it as "nothing was created, nothing changed." */
  onCancel: () => void;
  /** Extra class on the panel — board 04's dialog is 980px, board 08's is
   *  620px, and neither width belongs to this shared file. */
  className?: string;
}

/**
 * Every focusable, non-disabled element inside `root`, in DOM order — what
 * both the initial-focus effect and the Tab handler below need, kept as one
 * function so the definition of "focusable" cannot drift between the two.
 *
 * The `disabled`/`tabindex="-1"` exclusion is done as a JS filter rather
 * than folded into the selector as `:not(:disabled)` — jsdom's CSS engine
 * (nwsapi) does not preserve document order for a selector list that mixes
 * `:not()` clauses with plain ones, so `querySelectorAll` can hand back
 * "last, middle, first" instead of source order. Real engines don't have
 * this bug, but the fix is simple enough to apply everywhere rather than
 * trust jsdom in tests and a browser in production to agree.
 */
function focusable(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    "a[href], button, input, select, textarea, [tabindex]",
  );
  return Array.from(candidates).filter((el) => {
    if ("disabled" in el && (el as HTMLButtonElement).disabled) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    return true;
  });
}

export default function Dialog({ label, children, onCancel, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus enters the panel the moment it mounts — the first focusable
  // element, since a dialog built from a generic frame has no single field
  // this component could know to prefer over another. A caller that wants a
  // specific field focused (WorktreeDialog's name input, selected rather
  // than just focused) does that itself, after this effect has already run:
  // effects on the same mount run in the order they were queued, and a
  // child's own `useEffect` queues after this component's.
  useEffect(() => {
    const first = panelRef.current && focusable(panelRef.current)[0];
    first?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }

      // Tab is kept inside the panel rather than reaching whatever the
      // window has drawn behind the scrim — the same loop
      // `WorktreeDialog.tsx` implements, generalized over "whatever this
      // dialog's content happens to contain" instead of one input and two
      // buttons.
      if (e.key === "Tab" && panelRef.current) {
        const items = focusable(panelRef.current);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <motion.div
      className="k-dialog-scrim dialogs__scrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: instant }}
      exit={{ opacity: 0, transition: instantOut }}
      // A pointerdown on the scrim itself, not on the panel it wraps, reads
      // as the same "never mind" as Escape — matching every other
      // click-outside in the shell (`panel__confirm-scrim`,
      // `home__worktree-scrim`).
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <motion.div
        className={className ? `k-dialog ${className}` : "k-dialog"}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        variants={popover}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
