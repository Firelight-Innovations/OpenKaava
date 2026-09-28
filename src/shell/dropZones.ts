import { useCallback, useRef } from "react";
import type { DropTarget, SplitDir } from "./contract";

/**
 * The drop-target registry. Regions opt in — a pane registers itself as a pane,
 * a tab strip registers itself and a way to measure its tabs — so the drag layer
 * knows only the shapes below, never any region's DOM. Registration is a ref
 * callback rather than an effect, so a zone appears the moment its element does
 * and disappears the moment it unmounts; there is no window in which a pane is on
 * screen but not yet a target, which is exactly what a fast drag falls into.
 *
 * What this replaced, and why it is a module singleton rather than a context:
 * `docs/design-notes/shell-core.md`.
 */
export type DropZone =
  | { kind: "pane"; paneId: string }
  | {
      kind: "strip";
      /**
       * Which pane a release at this x lands in, and that pane's own tab rects.
       *
       * A function of the position rather than a fixed `paneId`, and a bug fix
       * rather than a generalisation — `docs/design-notes/shell-core.md` has what
       * the fixed version cost. The row is still one zone spanning the whole bar
       * (see the call site for why anything narrower is dangerous) and still
       * answers with the focused pane over the parts that are not any pane's
       * tabs; which region a point falls in is the bar's question about its own
       * markup. Measured on demand, because the row scrolls and a stale rect puts
       * the caret in the wrong gap the moment it does.
       */
      at: (x: number) => { paneId: string; tabRects: DOMRect[] };
    }
  | { kind: "panel" }
  /**
   * A cluster's own chip in the switcher bar — the target for KAAVA-UX-REWORK.md
   * §5's "drop a tab on a cluster tab to move it into that cluster." Registered
   * by `ClusterBar` via `clusterTabRef(id)`, one per chip; whether the drop is
   * actually allowed (same environment) is not this module's question — see
   * `useDrag`'s `resolve`, which stamps `refused` onto the `DropTarget` itself.
   */
  | { kind: "cluster"; clusterId: string }
  /**
   * The switcher bar's own background, behind and around every chip — the
   * catch-all for KAAVA-UX-REWORK.md §5's "drop on empty switcher space creates
   * a new cluster." One zone spanning the row, the same shape as `strip`'s
   * reasoning: a chip already answers `cluster` for the pixels it covers, so
   * this only wins where nothing more specific does, which `hitTest`'s pass
   * order enforces rather than this zone's bounds.
   */
  | { kind: "switcher" }
  /**
   * One session's emulator, wherever it is drawn — the band or a pane. The
   * target for **files** dragged in, and deliberately invisible to `hitTest`,
   * which answers for a dragged *tab*. An emulator sits inside a pane and
   * inside the panel, both already tab targets, so a zone answering both
   * questions would make a terminal tab dragged over another terminal's output
   * resolve to the emulator rather than the pane — silently changing a gesture
   * that works. Files ask `terminalAt`; the two share this registry and nothing
   * else.
   */
  | { kind: "terminal"; sessionId: string };

/** A registration holds the zone's **ref**, not the zone. A zone read at the
 *  moment it is hit-tested is never older than the render that last set it. This
 *  was `zone: DropZone`, a value copied in at attach time, and the copy was a bug
 *  with teeth — `docs/design-notes/shell-core.md` has the full account, including
 *  why reordering in the cluster bar kept working throughout. */
interface Registered {
  zone: { readonly current: DropZone };
  el: HTMLElement;
}

/** How far into a pane counts as its edge. A quarter of the axis, which is what
 *  VSCode's gesture feels like: far enough in that aiming for "this pane" does
 *  not accidentally split it, close enough that aiming for a split needs no
 *  precision. Smaller makes splitting fiddly; larger makes appending to a strip
 *  nearly impossible in a narrow pane. */
const EDGE_FRACTION = 0.25;

let zones: Registered[] = [];

function add(zone: { readonly current: DropZone }, el: HTMLElement): void {
  zones = [...zones.filter((z) => z.el !== el), { zone, el }];
}

function remove(el: HTMLElement): void {
  zones = zones.filter((z) => z.el !== el);
}

/** Where a release at this point would land. Most specific first, and the order
 *  is the whole logic: a strip sits inside the pane it belongs to, so testing
 *  panes first would mean a drop between two tabs always resolved to "append to
 *  this pane" and the insertion caret could never be honoured. */
export function hitTest(x: number, y: number): DropTarget {
  for (const { zone: held, el } of zones) {
    const zone = held.current;
    if (zone.kind !== "strip") continue;
    if (!within(el.getBoundingClientRect(), x, y)) continue;
    // The pane is resolved from where the pointer is, not from which pane
    // happens to be focused. See `DropZone`'s `at` for what the second one cost.
    const hit = zone.at(x);
    return { kind: "strip", paneId: hit.paneId, index: insertionIndex(hit.tabRects, x) };
  }

  for (const { zone: held, el } of zones) {
    const zone = held.current;
    if (zone.kind !== "pane") continue;
    const rect = el.getBoundingClientRect();
    if (!within(rect, x, y)) continue;
    return { kind: "pane", paneId: zone.paneId, ...edgeOf(rect, x, y) };
  }

  for (const { zone: held, el } of zones) {
    const zone = held.current;
    if (zone.kind !== "cluster") continue;
    if (within(el.getBoundingClientRect(), x, y)) {
      // `refused` is a geometric hit test's business only in the sense that
      // it must set *something*: whether the environments actually agree is
      // not information this module has. `useDrag`'s `resolve` recomputes it
      // from the payload before the caller ever sees this value — see
      // `DropTarget`'s own doc comment on the field.
      return { kind: "cluster", clusterId: zone.clusterId, refused: false };
    }
  }

  for (const { zone: held, el } of zones) {
    if (held.current.kind !== "panel") continue;
    if (within(el.getBoundingClientRect(), x, y)) return { kind: "panel" };
  }

  for (const { zone: held, el } of zones) {
    if (held.current.kind !== "switcher") continue;
    if (within(el.getBoundingClientRect(), x, y)) return { kind: "new-cluster" };
  }

  // Over no registered zone. Releasing here makes a window.
  return { kind: "detach" };
}

/** Which terminal session a point is over, or `null` for none.
 *
 *  The whole of the file-drop hit test, separate from `hitTest` rather than a
 *  fourth pass inside it — see the `terminal` zone for why one function
 *  answering both questions would change what a tab drag does. An overlap
 *  cannot arise: the deck hides all but the active emulator with
 *  `display: none`, and a hidden element measures 0x0. */
export function terminalAt(x: number, y: number): string | null {
  for (const { zone: held, el } of zones) {
    const zone = held.current;
    if (zone.kind !== "terminal") continue;
    if (within(el.getBoundingClientRect(), x, y)) return zone.sessionId;
  }
  return null;
}

/** The rectangle a pane is drawn on right now, or `null` if it is not on screen.
 *  Not a drag concern, and here anyway because this registry is already the one
 *  thing in the shell that knows which element is which pane; the alternative was
 *  a second lookup reaching for `.pane` by class name, which is what this module
 *  exists to have replaced. Measured on the spot rather than cached — a divider
 *  drag and an OS window resize both move these without going through React. The
 *  caller is `panes/splitOnOpen.ts`, and reading goes through the held ref, so it
 *  is never older than the render that last set it (see `Registered`). */
export function paneRect(paneId: string): DOMRect | null {
  for (const { zone: held, el } of zones) {
    const zone = held.current;
    if (zone.kind === "pane" && zone.paneId === paneId) return el.getBoundingClientRect();
  }
  return null;
}

/** Register an element as a drop target. Returns a ref callback to spread onto it.
 *
 *  The zone is read through a ref so the returned callback's identity is stable.
 *  An unstable ref callback makes React detach and reattach on every render,
 *  which here would mean deregistering and reregistering the zone continuously —
 *  and a drag sampling the registry mid-render would see it missing. That
 *  stability is exactly why the ref itself has to be registered rather than the
 *  zone it currently holds: a callback React only ever calls once cannot keep a
 *  registration current. See `Registered`. */
export function useDropZone(zone: DropZone): (el: HTMLElement | null) => void {
  const held = useRef<HTMLElement | null>(null);
  const latest = useRef(zone);
  latest.current = zone;

  return useCallback((el: HTMLElement | null) => {
    if (held.current) remove(held.current);
    held.current = el;
    if (el) add(latest, el);
  }, []);
}

function within(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/** Which edge band a point falls in, or none. Left and right give a row split —
 *  the panes end up side by side — and top and bottom a column. `before` says
 *  which side the new pane takes, so dropping on the left opens to the left
 *  rather than always to the right. The horizontal bands are tested first: a
 *  pane's tab strip already occupies its top edge and is a strip zone of its own,
 *  so the only way to reach the top band is below that strip, where a sideways
 *  intent is the more likely one. */
function edgeOf(rect: DOMRect, x: number, y: number): { edge: SplitDir | null; before: boolean } {
  const bandX = rect.width * EDGE_FRACTION;
  const bandY = rect.height * EDGE_FRACTION;

  if (x - rect.left < bandX) return { edge: "row", before: true };
  if (rect.right - x < bandX) return { edge: "row", before: false };
  if (y - rect.top < bandY) return { edge: "column", before: true };
  if (rect.bottom - y < bandY) return { edge: "column", before: false };
  return { edge: null, before: false };
}

/** How many tab midpoints the pointer has passed — the index a drop inserts at.
 *  Midpoints rather than leading edges, so a tab changes places once the pointer
 *  is more than half past it, which is where the eye expects it to. */
function insertionIndex(rects: DOMRect[], x: number): number {
  let index = 0;
  for (const rect of rects) {
    if (x > rect.left + rect.width / 2) index += 1;
  }
  return index;
}
