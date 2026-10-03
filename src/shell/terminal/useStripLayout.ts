import { useEffect, useRef, useState, type RefObject } from "react";
import { nextStripLayout, type StripLayout } from "./contextLayout";
import { isResizing, subscribeResizing } from "../resizeGate";

/**
 * The strip's side for the element in `ref`, from a `ResizeObserver` on that
 * element. Frozen while a splitter drag is in progress and re-evaluated once on
 * release, so the layout never flips under the user's cursor.
 */
export function useStripLayout(ref: RefObject<HTMLElement | null>): StripLayout {
  const [layout, setLayout] = useState<StripLayout>("side");
  const current = useRef<StripLayout>("side");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const evaluate = () => {
      if (isResizing()) return;
      const rect = el.getBoundingClientRect();
      const next = nextStripLayout(current.current, rect);
      if (next !== current.current) {
        current.current = next;
        setLayout(next);
      }
    };
    const observer = new ResizeObserver(evaluate);
    observer.observe(el);
    const unsubscribe = subscribeResizing(evaluate);
    evaluate();
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, [ref]);

  return layout;
}
