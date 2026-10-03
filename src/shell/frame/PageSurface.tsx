import { useEffect, useRef, type ReactNode } from "react";
import { animate, motion, useMotionValue, usePresence, type MotionValue } from "framer-motion";
import { PAGE_TOGGLE_FROM, pageOut, snap } from "../motion";

export type PageMode = "docked" | "expanded";

/** What one progress value (0 tucked into the rail, 1 settled) looks like. */
export interface PageFrame {
  x: string;
  clipPath: string;
  opacity: number;
}

/**
 * The paint for a page at `progress`.
 *
 * Docked slides in from the rail edge by `translateX`. Expanded is revealed by
 * a clip that opens from the rail side, so it grows out of the rail without
 * scaling the app inside it: the box is its final size from the first frame,
 * and only what is painted changes. Reduced motion keeps only the opacity.
 */
export function pageFrame(progress: number, mode: PageMode, reduced: boolean): PageFrame {
  const p = Math.min(Math.max(progress, 0), 1);
  if (reduced) return { x: "0%", clipPath: "none", opacity: p };
  const opacity = Math.min(1, p / 0.6);
  if (mode === "docked") return { x: `${(1 - p) * 100}%`, clipPath: "none", opacity };
  return { x: "0%", clipPath: `inset(0% 0% 0% ${(1 - p) * 100}%)`, opacity };
}

/**
 * The one surface a rail page lives on, docked or expanded.
 *
 * Only transform, clip and opacity animate; the box is at its final geometry
 * from the first frame, so panes and the app iframe measure the settled layout
 * and never a mid-flight one. It stays mounted across a dock/expand toggle
 * (the mode is a prop, not a key) so the iframe host inside is never remounted.
 *
 * It is a direct child of `AnimatePresence`: when the page closes,
 * `usePresence` keeps it mounted until the tuck-in finishes, then releases it.
 */
export default function PageSurface({
  mode,
  reduced,
  width,
  onSettled,
  children,
}: {
  mode: PageMode;
  reduced: boolean;
  /** The docked width motion value; ignored while expanded. */
  width: MotionValue<number>;
  /** The enter or toggle animation finished (or was skipped). */
  onSettled: (mode: PageMode) => void;
  children: ReactNode;
}) {
  const [isPresent, safeToRemove] = usePresence();
  const progress = useMotionValue(reduced ? 1 : 0);
  const first = pageFrame(progress.get(), mode, reduced);
  const x = useMotionValue(first.x);
  const clipPath = useMotionValue(first.clipPath);
  const opacity = useMotionValue(first.opacity);
  // Its own motion value, never swapped for a plain style: framer keeps the
  // last inline width when a bound value is replaced or removed, so an
  // expanded page stayed at the docked 380px.
  const boxWidth = useMotionValue<number | string>(mode === "docked" ? width.get() : "auto");
  useEffect(() => {
    if (mode !== "docked") {
      boxWidth.set("auto");
      return;
    }
    boxWidth.set(width.get());
    return width.on("change", (w) => boxWidth.set(w));
  }, [mode, width, boxWidth]);

  useEffect(() => {
    const apply = (v: number) => {
      const f = pageFrame(v, mode, reduced);
      x.set(f.x);
      clipPath.set(f.clipPath);
      opacity.set(f.opacity);
    };
    apply(progress.get());
    return progress.on("change", apply);
  }, [mode, reduced, progress, x, clipPath, opacity]);

  const seenMode = useRef<PageMode | null>(null);
  useEffect(() => {
    if (!isPresent) {
      if (reduced) {
        progress.set(0);
        safeToRemove?.();
        return;
      }
      const out = animate(progress, 0, { ...pageOut, onComplete: () => safeToRemove?.() });
      return () => out.stop();
    }
    const toggled = seenMode.current !== null && seenMode.current !== mode;
    seenMode.current = mode;
    if (reduced) {
      progress.set(1);
      onSettled(mode);
      return;
    }
    if (toggled) progress.set(PAGE_TOGGLE_FROM);
    const enter = animate(progress, 1, { ...snap, onComplete: () => onSettled(mode) });
    return () => enter.stop();
  }, [isPresent, mode, reduced, progress, safeToRemove, onSettled]);

  return (
    <motion.div
      className={mode === "docked" ? "frame__page" : "frame__page-expanded"}
      data-region={mode === "docked" ? "page" : "page-expanded"}
      data-leaving={isPresent ? undefined : ""}
      style={{ width: boxWidth, x, clipPath, opacity }}
    >
      {children}
    </motion.div>
  );
}
