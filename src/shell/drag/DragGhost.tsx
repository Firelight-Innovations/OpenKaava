/**
 * The chip that follows the cursor during a drag.
 *
 * Every dimension is read from the handoff's interaction crops
 * (docs/handoffs/shell-spec.html) and recorded on the branch that draws it.
 * All kinds share background `--surface-2` ("ghost chip" in the token table),
 * border `--accent-line-strong` (the crop's .7 of the accent), 4px radius
 * and `opacity: .92`; the box-shadow alphas (.5 tool, .55 terminal) are kept as
 * drawn rather than collapsed into one.
 */
import type { MotionValue } from "framer-motion";
import { motion } from "framer-motion";
import type { DragPayload } from "../contract";

export default function DragGhost({
  payload,
  x,
  y,
}: {
  payload: DragPayload;
  x: MotionValue<number>;
  y: MotionValue<number>;
}) {
  // No crop covers dragging a whole cluster to another window. Rather than
  // invent a fourth box, this is a translucent copy of the chip it came from:
  // `.switcher__tab`'s height, padding, font and square corners, its fill and
  // accent rule at lower opacity — see `.drag-ghost--cluster` in drag.css.
  if (payload.what === "cluster") {
    return (
      <motion.div className="drag-ghost drag-ghost--cluster" style={{ left: x, top: y }}>
        <span className="drag-ghost-label">{payload.name}</span>
      </motion.div>
    );
  }

  // Tool (INTERACTION 01, frame 2): 28px tall, padding 0 13px, name at
  // `font:500 12px/1 'IBM Plex Sans'`. Terminal (INTERACTION 02): 25px tall,
  // padding 0 11px, gap 7px to a 5px status dot, title at
  // `font:500 11px/1 'IBM Plex Sans'`. Both readings survive the payload types
  // merging: `kind` still says which a tab is and the crops still differ — one
  // payload type was the right simplification, one visual treatment would have
  // been a redesign nobody asked for.
  //
  // A tool ghost carries only its title: no health, no version, matching "no
  // per-tool state on tabs". A terminal's adds the same *agent finished* dot its
  // panel tab carries. Nothing else reaches the ghost either.
  return (
    <motion.div className={`drag-ghost drag-ghost--${payload.kind}`} style={{ left: x, top: y }}>
      <span className="drag-ghost-label">{payload.title}</span>
      {payload.kind === "terminal" && payload.agentFinished && <span className="drag-ghost-dot" />}
    </motion.div>
  );
}
