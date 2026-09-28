/**
 * The floating hint bar under the ghost chip — board 07's "Split right | Esc
 * cancel" strip. Text only, off `dropLabel`; see that function for why the
 * board's middle clause ("Ctrl copy") is not here.
 *
 * Follows the same springs as the ghost chip it sits under, for the same
 * reason `DragGhost` does: one motion value per axis, chased rather than
 * re-rendered, so it tracks the cursor at 1:1 under load.
 */
import type { MotionValue } from "framer-motion";
import { motion } from "framer-motion";
import type { DropTarget } from "../contract";
import { dropLabel } from "../dropLabel";
import { instant, instantOut } from "../motion";

const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: instant },
  exit: { opacity: 0, transition: instantOut },
};

export default function DropHint({
  target,
  x,
  y,
}: {
  target: DropTarget | null;
  x: MotionValue<number>;
  y: MotionValue<number>;
}) {
  const label = dropLabel(target);
  if (!label) return null;

  return (
    <motion.div className="drag-hint" style={{ left: x, top: y }} {...fade}>
      <span className="drag-hint-label">{label}</span>
      <span className="drag-hint-sep">·</span>
      <span className="drag-hint-key">Esc</span>
      <span className="drag-hint-action">cancel</span>
    </motion.div>
  );
}
