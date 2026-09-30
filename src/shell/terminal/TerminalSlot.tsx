import { useRef, type CSSProperties, type PointerEventHandler, type ReactNode } from "react";
import ContextStrip, { ContextNotice } from "./ContextStrip";
import { useStripLayout } from "./useStripLayout";

/**
 * One session's box in the deck: the emulator, its Context strip and the notice.
 *
 * Owns the strip's side. The box is measured, not the window, so a tall narrow
 * dock puts the strip under the terminal as a band and a wide one keeps the
 * column. The measurement is of this box, which is the same size in both
 * layouts, so the layout cannot feed back into what decides it.
 */
export default function TerminalSlot({
  sessionId,
  className,
  active,
  focused,
  style,
  onPointerDown,
  children,
}: {
  sessionId: string;
  className: string;
  active: boolean;
  focused: boolean;
  style?: CSSProperties;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  /** The emulator. */
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const layout = useStripLayout(ref);

  return (
    <div
      ref={ref}
      className={className}
      data-active={active || undefined}
      data-focused={focused || undefined}
      data-strip={layout}
      style={style}
      onPointerDown={onPointerDown}
    >
      {children}
      {/* Mounted for every session, hidden slots included, so a strip keeps its
          subscription and never refetches on a tab switch. It renders nothing
          until the environment has context. */}
      <ContextStrip sessionId={sessionId} layout={layout} />
      {/* In the band layout the notice is anchored to a zero-height row that
          sits between the emulator and the band, so it floats over the
          terminal's lower edge rather than over the band. */}
      {layout === "bottom" ? (
        <div className="ctxnotice-anchor">
          <ContextNotice sessionId={sessionId} />
        </div>
      ) : (
        <ContextNotice sessionId={sessionId} />
      )}
    </div>
  );
}
