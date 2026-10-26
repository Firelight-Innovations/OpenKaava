/**
 * A right-click menu on the shell's own menu surface, for a subject that is not
 * a text field.
 *
 * `ContextMenuHost` is the document's edit menu (cut, copy, paste) and takes its
 * rows from what the click landed in; a menu about a cluster or an agent is a
 * different menu for a different subject, so it does not go through it. It
 * reuses the *surface* instead: the `.context-menu` box, `MenuItemList`'s rows
 * (including its rename prompt), `placeMenu`'s flip-and-clamp, and the way
 * `ContextMenuHost` dismisses. The clicking element calls `preventDefault` on
 * its `contextmenu` event, which is what tells `ContextMenuHost` to stand down.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { MenuItem } from "./contract";
import { placeMenu, type Point } from "./contextMenu";
import MenuItemList, { inMenuSurface } from "./MenuItemList";
import { popover } from "./motion";
import "./contextMenu.css";

/** An open menu: where it was asked for, what it is called, and its rows. */
export interface OpenContextMenu {
  at: Point;
  /** The menu's accessible name. */
  label: string;
  items: MenuItem[];
}

export default function ContextMenuSurface({
  opened,
  onClose,
}: {
  opened: OpenContextMenu | null;
  onClose: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Point>({ x: 0, y: 0 });

  useEffect(() => {
    if (opened === null) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 2) return;
      const inside =
        surfaceRef.current?.contains(e.target as Node) === true || inMenuSurface(e.target);
      if (!inside) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [opened, onClose]);

  // Placed after layout, from the measured size, so the first painted frame is
  // already flipped away from a window edge. See `ContextMenuHost`.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (opened === null || !surface) return;
    const rect = surface.getBoundingClientRect();
    setAt(
      placeMenu(
        opened.at,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    surface.focus({ preventScroll: true });
  }, [opened]);

  return createPortal(
    <AnimatePresence>
      {opened !== null && (
        <motion.div
          ref={surfaceRef}
          className="context-menu"
          role="menu"
          aria-label={opened.label}
          tabIndex={-1}
          style={{ top: at.y, left: at.x }}
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItemList items={opened.items} onAfterSelect={onClose} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
