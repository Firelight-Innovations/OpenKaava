/**
 * The eight inline menu labels, ≥1180px.
 *
 * Standard menu-bar behaviour: a menu opens on click; while one is open,
 * hovering a sibling switches to it without a second click; Escape, a click
 * outside, or anything that takes focus out of this document closes whichever
 * is open. One `openLabel` captures all of that — the dropdown that's showing
 * is just "the menu whose label equals `openLabel`".
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Menu } from "../contract";
import { popover } from "../motion";
import MenuItemList, { inMenuSurface } from "../MenuItemList";

export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openLabel === null) return;

    const onPointerDown = (e: PointerEvent) => {
      // A submenu is portalled to `document.body`, so it is not inside this
      // component's subtree and `contains` says "outside" about a click that is
      // very much inside this menu. Missing it would unmount the submenu on the
      // pointerdown of the click meant to choose an item, and the `click` would
      // land on nothing — the same failure `AddAppButton` documents for its own
      // portalled surface. See `inMenuSurface`.
      if (inMenuSurface(e.target)) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpenLabel(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenLabel(null);
    };

    // Why blur as well, when `onPointerDown` already handles "clicked
    // outside": most of this window is not in this document. Every app and tool
    // surface is an iframe, and a pointer event inside one is delivered to that
    // frame and never reaches the shell's `window` — so clicking into the file
    // tree, an editor or a terminal left the menu hanging open, and the only
    // way to dismiss it was to click the label a second time. Focus moving into
    // a frame *does* blur the top-level window, which is the one signal that
    // crosses the boundary without the app having to cooperate.
    //
    // It fires on alt-tab too, and that is wanted rather than tolerated: a menu
    // still open when the window comes back would be one left over from
    // whatever the user was doing somewhere else.
    const onBlur = () => setOpenLabel(null);

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [openLabel]);

  return (
    <div className="menubar" ref={rootRef}>
      {menus.map((menu) => (
        <div key={menu.label} className="menubar__item-wrap">
          <button
            type="button"
            className="menubar__item"
            aria-haspopup="menu"
            aria-expanded={openLabel === menu.label}
            data-open={openLabel === menu.label || undefined}
            onClick={() => setOpenLabel((cur) => (cur === menu.label ? null : menu.label))}
            onPointerEnter={() => {
              if (openLabel !== null && openLabel !== menu.label) setOpenLabel(menu.label);
            }}
          >
            {menu.label}
          </button>
          <AnimatePresence>
            {openLabel === menu.label && (
              <motion.div
                className="menubar__dropdown"
                initial={popover.initial}
                animate={popover.animate}
                exit={popover.exit}
              >
                <MenuItemList items={menu.items} onAfterSelect={() => setOpenLabel(null)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
