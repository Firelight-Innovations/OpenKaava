/**
 * The two drop-target outlines. Both fade and scale in with `instant` (and
 * out with `instantOut`) — nothing here invents a transition, the numbers
 * live in `motion.ts` and this file only composes them into a variant.
 */
import type { MotionValue } from "framer-motion";
import { motion } from "framer-motion";
import { instant, instantOut } from "../motion";

const fade = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: instant },
  exit: { opacity: 0, scale: 0.98, transition: instantOut },
};

/**
 * "Clear of the bar. Ghost follows the cursor, outline previews the new
 * window" (INTERACTION 01, frame 2). The crop draws this at a specific
 * size, but that size is the storyboard's own layout, not a stated
 * dimension — the handoff explicitly leaves a detached window's real size
 * undecided ("NOT DECIDED — DO NOT INVENT"). This outline is decoration for
 * the drag, not a claim about that size: a fixed, modest rectangle near the
 * ghost, in the same dashed-accent treatment the crop draws
 * (`1.5px dashed` at .6 of the accent, 5px radius, `--accent-wash-faint`
 * fill — the .6 border alpha has no matching named token, so it's kept
 * literal here rather than forced onto a nearby one).
 */
export function DetachOutline({ x, y }: { x: MotionValue<number>; y: MotionValue<number> }) {
  return <motion.div className="drag-detach-outline" style={{ left: x, top: y }} {...fade} />;
}

/* The terminal band's own drop highlight is drawn by `BottomPanel` from its
   `dropActive` prop, and each pane's by `panes/PaneTree.tsx` from the live drop
   target. Both are inside the element being highlighted, which the overlay is
   not — an outline drawn out here would have to re-measure a rectangle its owner
   already knows, and would sit above a live iframe rather than around it. So the
   overlay keeps only the one indicator that has no owner: the detach outline,
   which by definition is over nothing. */
