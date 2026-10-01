import { useEffect, useState, type MutableRefObject } from "react";
import { CornerDownRight } from "lucide-react";
import type { LinkBadge } from "./nesting";

/** What the editor calls on every Excalidraw change; `LinkBadges` installs it. */
export type BadgeSink = (badges: LinkBadge[]) => void;

interface Props {
  /** The editor fills this with the sink while the overlay is mounted. */
  sinkRef: MutableRefObject<BadgeSink | null>;
  onOpen: (child: string) => void;
}

const same = (a: LinkBadge[], b: LinkBadge[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.id === b[i]!.id &&
      x.child === b[i]!.child &&
      x.label === b[i]!.label &&
      x.right === b[i]!.right &&
      x.bottom === b[i]!.bottom &&
      x.compact === b[i]!.compact,
  );

/**
 * A chip over each frame that links to a child canvas, saying where a double-click
 * goes; clicking it opens the child too. Positioned from scene coordinates by the
 * editor (so it tracks scroll and zoom) and drawn here as ordinary DOM over the
 * canvas: it is not an element, so it is never saved, selected or exported.
 *
 * The overlay ignores the pointer except on the chips, so drawing and selecting
 * underneath work as before.
 */
export default function LinkBadges({ sinkRef, onOpen }: Props) {
  const [badges, setBadges] = useState<LinkBadge[]>([]);
  useEffect(() => {
    const ref = sinkRef;
    ref.current = (next) => setBadges((prev) => (same(prev, next) ? prev : next));
    return () => {
      ref.current = null;
    };
  }, [sinkRef]);

  return (
    <div className="cv__badges" aria-label="Frames that open a canvas">
      {badges.map((b) => (
        <button
          key={b.id}
          type="button"
          className={`cv__badge${b.compact ? " is-compact" : ""}`}
          style={{ right: `calc(100% - ${b.right}px)`, bottom: `calc(100% - ${b.bottom}px)` }}
          title={`Opens ${b.child} (or double-click the frame)`}
          aria-label={`Open canvas ${b.label}`}
          onClick={() => onOpen(b.child)}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <CornerDownRight size={12} aria-hidden />
          {!b.compact && <span>{b.label}</span>}
        </button>
      ))}
    </div>
  );
}
