import { useCallback, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "./dockedpage.css";

/**
 * `pages::{MIN_WIDTH,MAX_WIDTH,DEFAULT_WIDTH}`, mirrored -- `RightPage.width`
 * itself is already clamped server-side, but the drag handle below needs its
 * own copy to keep the pointer from visibly outrunning the value it sends.
 */
export const DOCKED_MIN_WIDTH = 320;
export const DOCKED_MAX_WIDTH = 640;
export const DOCKED_DEFAULT_WIDTH = 380;

export interface DockedPageProps {
  title: string;
  subtitle?: string;
  /** `right_page.width`, in CSS pixels -- the aside's own width, not a track weight. */
  width: number;
  /** Fired continuously while the handle drags, already clamped. */
  onWidthChange: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The docked page shell: a `380px`-default, `320`-`640px` aside beside the
 * panes, per `KAAVA-UX-SPEC.md` §1.8. Every docked page (Git, Hindsight,
 * Cost, the registry) shares this header and this handle; only `children` —
 * the page's own body — differs between them.
 *
 * The handle sits on the aside's left edge, since the aside itself sits at
 * the window's right edge: dragging left (negative `dx`) widens it.
 */
export default function DockedPage({
  title,
  subtitle,
  width,
  onWidthChange,
  onClose,
  children,
}: DockedPageProps) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStart.current = { x: e.clientX, width };
    },
    [width],
  );

  const onHandlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStart.current;
      if (!start) return;
      const next = Math.min(
        DOCKED_MAX_WIDTH,
        Math.max(DOCKED_MIN_WIDTH, start.width - (e.clientX - start.x)),
      );
      onWidthChange(next);
    },
    [onWidthChange],
  );

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <aside className="k-docked-page" style={{ width }} aria-label={title}>
      <div
        className="k-docked-page__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      />
      <header className="k-docked-page__header">
        <span className="k-docked-page__title">{title}</span>
        {subtitle && <span className="k-docked-page__subtitle">{subtitle}</span>}
        <button
          type="button"
          className="k-docked-page__close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.6} aria-hidden />
        </button>
      </header>
      <div className="k-docked-page__body">{children}</div>
    </aside>
  );
}
