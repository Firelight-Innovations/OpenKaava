import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { MessageSquare } from "lucide-react";
import {
  placement,
  sceneBox,
  toScreen,
  type Highlight,
  type HighlightView,
} from "./commentHighlight";
import type { Box } from "./review";
import type { SceneElement } from "./scene";

/** What the editor calls on every Excalidraw change; `HighlightOverlay` installs it. */
export type HighlightSink = (elements: readonly SceneElement[], view: HighlightView) => void;

interface Props {
  highlights: Highlight[];
  sinkRef: MutableRefObject<HighlightSink | null>;
}

const sameView = (a: HighlightView | null, b: HighlightView) =>
  a !== null &&
  a.scrollX === b.scrollX &&
  a.scrollY === b.scrollY &&
  a.zoom.value === b.zoom.value &&
  a.width === b.width &&
  a.height === b.height;

/**
 * A border round what a comment is about, with a pin and a leader line, drawn
 * as DOM over the editor: it is not an element, so it is never saved, selected,
 * exported or sent to an agent.
 *
 * Cost: with nothing to show the sink only stores two references. With
 * something to show, scene boxes are recomputed only when the editor hands over
 * a different elements array (an edit), and a pan or zoom re-renders just this
 * component with a few multiplications. Nothing walks the elements per frame.
 */
export default function HighlightOverlay({ highlights, sinkRef }: Props) {
  const elementsRef = useRef<readonly SceneElement[]>([]);
  const [elements, setElements] = useState<readonly SceneElement[]>([]);
  const [view, setView] = useState<HighlightView | null>(null);
  const viewRef = useRef<HighlightView | null>(null);
  const activeRef = useRef(false);
  activeRef.current = highlights.length > 0;

  useEffect(() => {
    const ref = sinkRef;
    ref.current = (next, v) => {
      elementsRef.current = next;
      const changedView = !sameView(viewRef.current, v);
      viewRef.current = v;
      if (!activeRef.current) return;
      setElements((prev) => (prev === next ? prev : next));
      if (changedView) setView(v);
    };
    return () => {
      ref.current = null;
    };
  }, [sinkRef]);

  // A target chosen while the editor is idle has had no change to report yet.
  useEffect(() => {
    if (highlights.length === 0) return;
    setElements(elementsRef.current);
    setView(viewRef.current);
  }, [highlights.length]);

  const boxes = useMemo(() => {
    const out: { h: Highlight; box: Box }[] = [];
    for (const h of highlights) {
      const box = sceneBox(elements, h.spec);
      if (box) out.push({ h, box });
    }
    return out;
  }, [highlights, elements]);

  if (!view || boxes.length === 0) return null;
  const size = { width: view.width, height: view.height };

  return (
    <div className="cv__hl" aria-hidden>
      {boxes.map(({ h, box }) => {
        const p = placement(toScreen(box, view), size);
        return (
          <div key={h.key} className={`cv__hl-item cv__hl-item--${h.kind}`}>
            <span
              className="cv__hl-box"
              style={{
                left: p.rect.x,
                top: p.rect.y,
                width: p.rect.width,
                height: p.rect.height,
              }}
            />
            {p.leader && (
              <svg className="cv__hl-leader" width={size.width} height={size.height}>
                <line x1={p.pin.x} y1={p.pin.y} x2={p.leader.x} y2={p.leader.y} />
              </svg>
            )}
            <span className="cv__hl-pin" style={{ left: p.pin.x, top: p.pin.y }}>
              <MessageSquare size={13} aria-hidden />
            </span>
          </div>
        );
      })}
    </div>
  );
}
