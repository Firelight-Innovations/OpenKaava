import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import type { FrameSlots, WindowKind } from "../contract";
import { settle } from "../motion";
import { beginResize } from "../resizeGate";
import PageSurface, { type PageMode } from "./PageSurface";
import { pageGeometry, pageWidthFromPointer } from "./pageGeometry";
import "./frame.css";

/**
 * The window's geometry, and nothing else.
 *
 * Five bands stacked in a column, only the middle one growing. The frame knows
 * how tall each bar is and how the middle row splits; it knows nothing about
 * what any of them contain. Regions arrive as slots, already built, and cannot
 * affect each other's size — which is the property that lets them be built in
 * parallel.
 *
 * The docked page's width lives here rather than inside the page for the same
 * reason the bars' heights do: it is the shape of the window, and the thing
 * being resized is the *split*, not the page. The page receives a box.
 */

/** The project-page rail's fixed width (`docs/design/KAAVA-UX-SPEC.md` §1.7).
 *  It never resizes or collapses — six page buttons are the whole of it. Not
 *  in `tokens.json`; the common brief's instructions are to define a missing
 *  geometry token locally and say so in the PR, which this is. */
export const PROJECT_RAIL_WIDTH = 44;
/** A docked project page's width range (§1.8) and default. The spec's own
 *  §5.2 flags three different rendered widths across the file set (330/360/
 *  380); 380 is `w-panel-default` and the one this workstream builds to. */
export const PROJECT_PAGE_MIN = 320;
export const PROJECT_PAGE_MAX = 640;
export const PROJECT_PAGE_DEFAULT = 380;

/** The shortest the terminal band opens to. Below this it snaps shut instead. */
export const BOTTOM_MIN = 120;
/** What the band opens to the first time, before anyone has dragged it. */
export const BOTTOM_DEFAULT = 260;
/** The tool window's floor, so the band can never swallow the panes entirely. */
export const TOOLWINDOW_MIN_H = 120;
/**
 * How far *below* `BOTTOM_MIN` the pointer must travel before the band snaps
 * shut, and the gap it must climb back over to reopen.
 *
 * This is the "clicks into place" of the gesture. One shared threshold would
 * let a hand resting near the line flap the band open and shut several times in
 * one drag; the dead zone between the two means closing it takes a deliberate
 * shove and reopening takes a deliberate lift.
 */
export const BOTTOM_COLLAPSE_OVERSHOOT = 60;
/**
 * How far *past* the tool window's floor the pointer must travel before the
 * band takes the whole column, and how far back it must fall to give it up.
 *
 * The same dead zone `MAXIMIZE_OVERSHOOT` gives the panel, at the other end of
 * the same drag. A band that swallowed the apps the moment the pointer grazed
 * the floor would be one twitch away from hiding everything on screen.
 */
export const BOTTOM_MAXIMIZE_OVERSHOOT = 60;

/**
 * The project-page rail and the docked project page are the window's right
 * side: the rail is a fixed width, the page is
 * a split with its own width and its own handle, and an expanded page is a
 * third geometry — covering everything left of the rail while the panes
 * stay mounted behind it. See `FrameSlots.projectRail` / `projectPage` /
 * `projectPageExpanded`.
 *
 * `envBar` is the plainest of the lot: a fixed-height row at the top of
 * `.frame__main`, ahead of the tool window, with no drag of its own — see
 * `FrameSlots.envBar`.
 */
export default function Frame({
  kind,
  slots,
  bottomHeight = BOTTOM_DEFAULT,
  bottomCollapsed = true,
  bottomMaximized = false,
  onBottomHeightChange,
  onBottomCollapsedChange,
  onBottomMaximizedChange,
  projectPageWidth = PROJECT_PAGE_DEFAULT,
  onProjectPageWidthChange,
  projectPageExpanded = false,
}: {
  kind: WindowKind;
  slots: FrameSlots;
  /**
   * The terminal band's last open height, and whether it is shut.
   *
   * Defaulted rather than required so a caller with no `slots.bottomPanel` — a
   * detached window — needs no opinion about a band it does not draw. A caller
   * that *does* pass the slot owns this state, the same way it owns the panel's
   * width: the thing being resized is the split, not the band.
   *
   * Shut is the default because the band holds no sessions until something asks
   * for one, and a window that opened with an empty terminal band every launch
   * would be spending height on nothing.
   */
  bottomHeight?: number;
  bottomCollapsed?: boolean;
  /**
   * The band has taken the whole column and the tool window is at zero.
   *
   * The apps are still mounted at that height — this is the same box they
   * always sat in, measuring nothing — so pulling the band back down puts them
   * back rather than reopening them. See `.frame__toolwindow`'s `overflow`.
   */
  bottomMaximized?: boolean;
  onBottomHeightChange?: (height: number) => void;
  onBottomCollapsedChange?: (collapsed: boolean) => void;
  onBottomMaximizedChange?: (maximized: boolean) => void;
  /**
   * The docked project page's last width. The thing being resized is the
   * split, so the caller owns it and `Frame` only ever reports a drag's
   * result. Defaulted so a caller with no
   * `slots.projectPage` need not have an opinion about a split it does not
   * draw.
   */
  projectPageWidth?: number;
  onProjectPageWidthChange?: (width: number) => void;
  /** Swaps `slots.projectPage` for `slots.projectPageExpanded` and hides the
   *  panes behind it with `visibility` rather than unmounting them. See
   *  `FrameSlots.projectPageExpanded`. */
  projectPageExpanded?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  // The band's height is a motion value rather than React state on purpose.
  // A drag has to be exactly 1:1 with the cursor, and routing every frame
  // through a re-render cannot promise that under load. Writing straight to
  // the motion value updates the DOM outside React's cycle; React only hears
  // the final height, on pointer up.
  const bottom = useMotionValue(bottomCollapsed ? 0 : bottomHeight);
  const mainRef = useRef<HTMLDivElement>(null);
  const bottomHandleRef = useRef<HTMLDivElement>(null);
  const bottomDragging = useRef(false);

  // The project page's width, on the same motion-value terms as the band's
  // height and for the same reason. No collapse and no maximize, just a
  // clamp, so there is no restoring effect to pair with it; the value already
  // equals `projectPageWidth` whenever nobody is dragging it.
  const pageWidth = useMotionValue(projectPageWidth);
  const pageDragging = useRef(false);
  useEffect(() => {
    if (!pageDragging.current) pageWidth.set(projectPageWidth);
  }, [projectPageWidth, pageWidth]);

  // The band with the tool window at zero: the column, minus the handle. A
  // fraction of the OS window rather than a number — see the resize observer
  // below.
  const bottomFull = useCallback(
    () =>
      (mainRef.current?.getBoundingClientRect().height ?? 0) -
      (bottomHandleRef.current?.getBoundingClientRect().height ?? 6),
    [],
  );

  // Opening and shutting the band is animated: it is a state change rather
  // than a gesture. Guarded against a drag in flight, or a toggle landing
  // mid-drag would start a spring that fights the pointer.
  useEffect(() => {
    if (bottomDragging.current) return;
    const target = bottomCollapsed ? 0 : bottomMaximized ? bottomFull() : bottomHeight;
    const controls = animate(bottom, target, settle);
    return () => controls.stop();
  }, [bottomCollapsed, bottomMaximized, bottomHeight, bottom, bottomFull]);

  // A maximized band has to be re-derived when the window changes size, exactly
  // as the maximized panel's width does: a fixed pixel height taken at the
  // moment of the drag would leave a strip of tool window showing the next time
  // the window grew. Guarded against a drag in flight for the same reason.
  useEffect(() => {
    const col = mainRef.current;
    if (!col) return;
    const observer = new ResizeObserver(() => {
      if (bottomDragging.current || bottomCollapsed || !bottomMaximized) return;
      bottom.set(bottomFull());
    });
    observer.observe(col);
    return () => observer.disconnect();
  }, [bottomCollapsed, bottomMaximized, bottom, bottomFull]);

  /**
   * Pull the band up, or shove it shut.
   *
   * The handle is a live grab strip whether the band is open or not — that is
   * what makes "reach for the bottom of the window and pull" work with nothing
   * on screen to pull. It is deliberately *not* a click target: opening this
   * band never spawns a terminal, it only reveals whatever is already there.
   */
  const onBottomHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const col = mainRef.current;
      if (!col) return;

      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Optimisation only; the window listeners below are the mechanism.
      }
      bottomDragging.current = true;
      const endResize = beginResize();

      const colRect = col.getBoundingClientRect();
      const colBottom = colRect.bottom;
      const handleH = bottomHandleRef.current?.getBoundingClientRect().height ?? 6;
      const full = colRect.height - handleH;
      // The tallest the band gets while still leaving the apps a usable strip.
      // Past this the drag stops resizing and starts minimizing them instead.
      const maxNormal = full - TOOLWINDOW_MIN_H;

      // Read once and mutated locally, never re-derived from raw position each
      // frame — re-deriving is exactly what the dead zones below exist to stop.
      let collapsed = bottomCollapsed;
      let maximized = bottomMaximized;

      const onMove = (ev: PointerEvent) => {
        const raw = colBottom - ev.clientY;

        if (raw < BOTTOM_MIN - BOTTOM_COLLAPSE_OVERSHOOT) {
          collapsed = true;
          // Shoving the band shut from the top of the window must not leave it
          // remembering that it was maximized: the next pull would then jump
          // straight back to full height instead of opening where it was let go.
          maximized = false;
        } else if (raw > BOTTOM_MIN) {
          collapsed = false;
        }

        if (raw > maxNormal + BOTTOM_MAXIMIZE_OVERSHOOT) maximized = true;
        else if (raw < maxNormal) maximized = false;

        const height = maximized
          ? full
          : Math.min(Math.max(raw, BOTTOM_MIN), Math.max(maxNormal, BOTTOM_MIN));
        bottom.set(collapsed ? 0 : height);
      };

      const onUp = () => {
        bottomDragging.current = false;
        endResize();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        onBottomCollapsedChange?.(collapsed);
        onBottomMaximizedChange?.(maximized);
        // `bottomHeight` means "last *normal* height" — neither shut nor
        // maximized may overwrite it, or coming back from either would land on
        // zero or on the full column rather than where the drag was let go.
        if (!collapsed && !maximized) onBottomHeightChange?.(bottom.get());
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [
      bottomCollapsed,
      bottomMaximized,
      onBottomHeightChange,
      onBottomCollapsedChange,
      onBottomMaximizedChange,
      bottom,
    ],
  );

  /**
   * The docked project page's own handle — a plain clamp between
   * `PROJECT_PAGE_MIN` and `PROJECT_PAGE_MAX`, on its leading edge (the page
   * sits left of the rail, so its width is the distance from the pointer to
   * the rail's edge, not the window's).
   */
  const onPageHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const row = rowRef.current;
      if (!row) return;

      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Optimisation only: capture keeps the gesture alive when the cursor
        // outruns the 6px handle, but it throws for a pointer id the browser
        // no longer considers active, and the window listeners below are what
        // actually track the drag.
      }
      pageDragging.current = true;
      const endResize = beginResize();

      const rowRight = row.getBoundingClientRect().right;

      const onMove = (ev: PointerEvent) => {
        const raw = pageWidthFromPointer(rowRight, PROJECT_RAIL_WIDTH, ev.clientX);
        pageWidth.set(Math.min(Math.max(raw, PROJECT_PAGE_MIN), PROJECT_PAGE_MAX));
      };

      const onUp = () => {
        pageDragging.current = false;
        endResize();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        onProjectPageWidthChange?.(pageWidth.get());
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [onProjectPageWidthChange, pageWidth],
  );

  const { docked, expanded } = pageGeometry(
    slots.projectPage,
    slots.projectPageExpanded,
    projectPageExpanded,
  );

  // The panes stay painted until the expanded page has finished growing over
  // them; hiding them on the first frame would show an empty canvas through
  // the part of the page that has not arrived yet. Reset the moment the page
  // is no longer expanded, so a close reveals them at once.
  const reducedMotion = useReducedMotion() ?? false;
  const [covered, setCovered] = useState(false);
  const onPageSettled = useCallback((mode: PageMode) => setCovered(mode === "expanded"), []);
  useEffect(() => {
    if (!expanded) setCovered(false);
  }, [expanded]);

  return (
    <div className="frame" data-window-kind={kind}>
      {/* Plain divs, fixed heights, no `layout` prop. The four bars never
          animate — only what sits inside them does. */}
      <div className="frame__titlebar" data-region="titlebar">
        {slots.titleBar}
      </div>

      {slots.switcherBar !== undefined && (
        <div className="frame__switcher" data-region="switcher">
          {slots.switcherBar}
        </div>
      )}

      <div className="frame__split" ref={rowRef}>
        {/* Everything left of the rail: the tool window, the terminal band
            and the docked project page. Wrapped so an
            expanded page can hide the lot in one move — `visibility`, not
            `display`, and not an unmount, so the panes underneath (and any
            terminal running in them) keep going behind it. See
            `FrameSlots.projectPageExpanded`. */}
        <div className="frame__workspace-body" data-hidden={(expanded && covered) || undefined}>
          {/* The tool window and the terminal band are one column, so the band
              stops at the docked page's edge instead of spanning the window.
              See `FrameSlots.bottomPanel` for why that is the arrangement. */}
          <div className="frame__main" ref={mainRef}>
            {slots.envBar !== undefined && (
              <div className="frame__envbar" data-region="envbar">
                {slots.envBar}
              </div>
            )}

            <div className="frame__toolwindow" data-region="toolwindow">
              {slots.toolWindow}
            </div>

            {slots.bottomPanel !== undefined && (
              <>
                <div
                  className="frame__bottomhandle"
                  data-region="bottomhandle"
                  ref={bottomHandleRef}
                  onPointerDown={onBottomHandleDown}
                  data-collapsed={bottomCollapsed || undefined}
                >
                  <div className="frame__bottomgrip" />
                </div>

                <motion.div
                  className="frame__bottom"
                  data-region="bottom"
                  style={{ height: bottom }}
                >
                  {slots.bottomPanel}
                </motion.div>
              </>
            )}
          </div>

          {/* The docked page's handle — omitted, not just empty, while no page
              is open or a page is showing expanded instead (`Board 12`'s
              rule: the two geometries are never both on screen). Omitted means
              no border and no gap: an empty bordered column is what
              `slotFilled` exists to prevent. */}
          {docked && (
            <div
              className="frame__pagehandle"
              data-region="pagehandle"
              onPointerDown={onPageHandleDown}
            >
              <div className="frame__grip" />
            </div>
          )}

          {/* The page itself, docked or expanded, as ONE surface. It pulls out
              of the rail on open and tucks back in on close (`PageSurface`),
              and `AnimatePresence` holds it mounted through the close. The
              mode is a prop, never a key: a dock/expand toggle re-shapes this
              element instead of replacing it, which is what keeps an app
              page's iframe host from being remounted. The expanded shape
              relies on `visibility: visible` fighting its hidden ancestor
              above by design — CSS lets a descendant do that. */}
          <AnimatePresence>
            {(docked || expanded) && (
              <PageSurface
                key="page"
                mode={expanded ? "expanded" : "docked"}
                reduced={reducedMotion}
                width={pageWidth}
                onSettled={onPageSettled}
              >
                {expanded ? slots.projectPageExpanded : slots.projectPage}
              </PageSurface>
            )}
          </AnimatePresence>

          {/* Last child of the hidden wrapper rather than of the row, so it
              covers the tool window and the docked page without reaching
              the rail beside it or the bars above and below. The wrapper keeps
              its own layout underneath — nothing here resizes anything, so
              closing the overlay restores the split exactly as it was. */}
          {slots.splitOverlay}
        </div>

        {/* The project-page rail. Outside the hidden wrapper on purpose — an
            expanded page still shows it (`docs/design/KAAVA-UX-SPEC.md` §1.8:
            "the rail persist[s]") — and it is a fixed width, never a split, so
            it takes no motion value of its own. */}
        {slots.projectRail !== undefined && (
          <div className="frame__rail" data-region="rail">
            {slots.projectRail}
          </div>
        )}
      </div>

      <div className="frame__statusbar" data-region="statusbar">
        {slots.statusBar}
      </div>

      {slots.overlay}
    </div>
  );
}
