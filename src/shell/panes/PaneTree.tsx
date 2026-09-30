/**
 * The recursive pane layout — splits, dividers, and now each pane's own tab
 * strip.
 *
 * **Tabs are back**, and that reverses this file's own former header, kept
 * below in spirit because the reasoning it gave has not stopped mattering —
 * only which row wins the argument has changed. The v3 boards (KAAVA-UX-SPEC
 * §1.6, board 07) draw a 34px strip on every pane; the `chrome` workstream is
 * pulling the equivalent inline-member listing out of `ClusterBar` in the
 * same rework, so a tab still appears in exactly *one* row rather than two
 * that can disagree — it has simply moved from the switcher down to the pane
 * it belongs to. `docs/design-notes/shell-chrome.md` is the fuller account of
 * why "one row" mattered enough to write down the first time; nothing about
 * that constraint changed, only where the row is drawn. See `PaneTabStrip.tsx`.
 *
 * **No surfaces**, still, and that separation is unchanged and still a
 * correctness requirement rather than a tidiness one; see `Pane`'s
 * `pane__host` below.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useDropZone } from "../dropZones";
import { paneLeaves } from "../contract";
import type { ClusterMember, PaneNode, PaneTreeProps, SplitDir } from "../contract";
import { dropLabel } from "../dropLabel";
import { beginResize } from "../resizeGate";
import { clampDividerShare, MIN_PANE_HEIGHT_PX, MIN_PANE_WIDTH_PX } from "./paneMinSize";
import PaneTabStrip from "./PaneTabStrip";
import "./panes.css";

// `PaneTreeProps` is in `contract.ts`, not here: `toolwindow` computes every
// field of it and hands it back through a `renderPanes` prop, which it could not
// type without importing this region (STANDARDS.md §1.2).

export default function PaneTree(props: PaneTreeProps) {
  const maximizedPaneId = props.maximizedPaneId ?? null;

  // `Esc` restores a maximised pane, matching KAAVA-UX-SPEC's "double-click
  // again or Esc restores." A ref for the callback rather than a dependency
  // on it directly: `WindowRoot`'s `onToggleMaximizePane` closure is not
  // guaranteed stable across renders, and re-subscribing on every one of them
  // would leave a window — small, but real — where this listener is briefly
  // absent between the old one detaching and the new one attaching.
  const onToggle = useRef(props.onToggleMaximizePane);
  onToggle.current = props.onToggleMaximizePane;

  useEffect(() => {
    if (!maximizedPaneId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle.current?.(maximizedPaneId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maximizedPaneId]);

  return <Node node={props.tree} {...props} />;
}

function Node({ node, ...props }: PaneTreeProps & { node: PaneNode }) {
  return node.kind === "leaf" ? <Pane leaf={node} {...props} /> : <Split split={node} {...props} />;
}

/** `.pane-split`'s `gap`, which `--space-1-5` sets to 6px. */
const SEAM_PX = 6;

// --- splits -----------------------------------------------------------------

function Split({
  split,
  ...props
}: PaneTreeProps & { split: Extract<PaneNode, { kind: "split" }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // One entry per child, so a divider can write flex-basis straight onto the
  // two elements it sits between. See `onDividerDown` for why that is done to
  // the DOM rather than through state.
  const childRefs = useRef<(HTMLDivElement | null)[]>([]);

  const row = split.dir === "row";
  const maximizedPaneId = props.maximizedPaneId ?? null;

  /**
   * Resize the two panes a divider sits between, and only those two.
   *
   * Written directly to the DOM for the whole gesture, exactly as
   * `Frame.tsx`'s panel handle does and for the same reason: dragging has to be
   * 1:1 with the cursor, and routing every frame of it through a re-render
   * cannot promise that under load — least of all here, where a re-render means
   * re-measuring every pane and repositioning every iframe in the window.
   * React hears the result once, on pointer-up.
   *
   * Only the adjacent pair moves. Redistributing across every child would mean
   * a drag between panes 1 and 2 quietly resizing panes 3 and 4, which is not
   * what the hand doing it is asking for.
   */
  const onDividerDown = useCallback(
    (index: number, e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      e.preventDefault();
      // Capture keeps the gesture alive when the cursor outruns the divider,
      // which it always does. It is an optimisation rather than the mechanism —
      // the window listeners below are what track the drag — and it throws for
      // a pointer id the browser no longer considers active, so it is guarded:
      // bare, a throw would abort the handler and lose the drag entirely.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Nothing to do; see above.
      }

      const rect = container.getBoundingClientRect();
      // The space the shares divide is the box less the seams between panes:
      // shares are flex-grow weights over that free space, so 1:1 tracking
      // needs the same denominator.
      const gaps = (split.children.length - 1) * SEAM_PX;
      const total = (row ? rect.width : rect.height) - gaps;
      if (total <= 0) return;
      // The pixel floor is on the axis the divider actually moves along: a
      // row split's panes sit side by side, so it is their *width* that must
      // not shrink below KAAVA-UX-SPEC's 200px; a column split's is height.
      const minPx = row ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;

      const start = row ? e.clientX : e.clientY;
      const before = split.sizes[index - 1] ?? 0.5;
      const after = split.sizes[index] ?? 0.5;
      // The pair's combined share is fixed for the gesture; the drag only
      // decides where the boundary inside it falls.
      const pair = before + after;

      let nextBefore = before;
      const endResize = beginResize();

      const onMove = (ev: PointerEvent) => {
        const moved = (row ? ev.clientX : ev.clientY) - start;
        const delta = moved / total;
        nextBefore = clampDividerShare(before + delta, pair, total, minPx);

        const first = childRefs.current[index - 1];
        const second = childRefs.current[index];
        if (first) first.style.flexGrow = `${nextBefore}`;
        if (second) second.style.flexGrow = `${pair - nextBefore}`;
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);

        const sizes = [...split.sizes];
        sizes[index - 1] = nextBefore;
        sizes[index] = pair - nextBefore;
        props.onResize(split.id, sizes);
        // After the sizes are committed, so the one fit sees the final layout.
        endResize();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [row, split.id, split.sizes, split.children.length, props],
  );

  return (
    <div className="pane-split" data-dir={split.dir} ref={containerRef}>
      {split.children.map((child, i) => {
        // While a pane elsewhere in the *window* is maximised — not
        // necessarily elsewhere in this split; a maximised pane's own
        // ancestors all "hold" it — every child that does not lead to it is
        // hidden outright, and the one that does is stretched to the split's
        // full share so the recursion below (its own `Split`, if it has one)
        // repeats the same rule one level down, all the way to the maximised
        // leaf's own `.pane`.
        const holds = maximizedPaneId
          ? paneLeaves(child).some((l) => l.id === maximizedPaneId)
          : true;

        return (
          <div
            key={child.id}
            className="pane-split__child"
            ref={(el) => {
              childRefs.current[i] = el;
            }}
            style={
              maximizedPaneId
                ? { flexGrow: holds ? 1 : undefined, display: holds ? undefined : "none" }
                : // The authored share: a fraction of the parent, one per child,
                  // summing to 1 — the same numbers `layout::PaneNode` stores,
                  // because the window is resizable and a layout in pixels
                  // would have to be recomputed on every resize and would
                  // restore wrongly onto a different monitor. A divider drag
                  // overwrites this inline for the duration of the gesture; the
                  // next render from `shell:state` puts the committed value
                  // back, which is the same number.
                  { flexGrow: split.sizes[i] ?? 1 / split.children.length }
            }
          >
            <Node node={child} {...props} />
            {/* Suppressed outright while anything is maximised: with one
                visible child there is no boundary left to grab, and a
                divider drawn at the edge of a hidden sibling would be a
                grab handle floating over nothing. */}
            {i > 0 && !maximizedPaneId && (
              <div
                className="pane-split__divider"
                data-dir={split.dir}
                onPointerDown={(e) => onDividerDown(i, e)}
                role="separator"
                aria-orientation={row ? "vertical" : "horizontal"}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- panes ------------------------------------------------------------------

function Pane({
  leaf,
  focusedPaneId,
  onFocusPane,
  onHostChange,
  dropTarget,
  members = [],
  onSelectMember,
  onCloseMember,
  dragHandleFor,
  onToggleMaximizePane,
  appPicker,
}: PaneTreeProps & { leaf: Extract<PaneNode, { kind: "leaf" }> }) {
  const hostRef = useCallback(
    (el: HTMLDivElement | null) => onHostChange(leaf.id, el),
    [leaf.id, onHostChange],
  );

  // Registered rather than found. The drag layer used to locate its targets by
  // querying the DOM, which cannot work now that panes come and go as the user
  // splits things — see `dropZones.ts`.
  const paneZone = useDropZone({ kind: "pane", paneId: leaf.id });

  const edge = dropTarget?.kind === "pane" && dropTarget.paneId === leaf.id ? dropTarget : null;
  const stripDropTarget =
    dropTarget?.kind === "strip" && dropTarget.paneId === leaf.id ? dropTarget : null;

  const ownMembers = useMemo(
    () => members.filter((m: ClusterMember) => m.paneId === leaf.id),
    [members, leaf.id],
  );

  return (
    <div
      className="pane"
      data-focused={focusedPaneId === leaf.id || undefined}
      onPointerDown={() => onFocusPane(leaf.id)}
      ref={paneZone}
    >
      {ownMembers.length > 0 && (
        <PaneTabStrip
          paneId={leaf.id}
          members={ownMembers}
          caret={stripDropTarget?.index ?? null}
          onSelect={onSelectMember ?? noop}
          onClose={onCloseMember ?? noop}
          onToggleMaximize={onToggleMaximizePane ?? noop}
          dragHandleFor={dragHandleFor}
          appPicker={appPicker}
        />
      )}

      {/* What `ToolWindow` measures. Deliberately empty: every pane is an
          empty content box that reports its element up through `onHostChange`,
          and `ToolWindow` positions the actual iframes over those boxes from a
          flat list that never reorders.

          That separation is a correctness requirement, not a tidiness one, and
          `TerminalDeck` already learned it the hard way — read its doc comment.
          Moving a mounted element to a new position in the React tree is
          indistinguishable, to React, from unmounting it and mounting a new
          one. A surface here is an iframe, and an iframe that remounts *reloads
          the app inside it*. If this component owned its panes' contents, every
          split, every divider drag and every tab dragged between panes would
          throw away the Files app's open file and scroll position.
          `createPortal` does not save you either: changing a portal's container
          remounts its children too. So the layout is a tree and the surfaces
          are a flat list, and the only thing that crosses between them is a
          measured rectangle. */}
      <div className="pane__host" ref={hostRef} />

      {/* Drop indicators sit above the surface, which is a live iframe — an
          outline drawn under one would be invisible exactly when it matters.
          Board 07's own five: this pane's centre is "add as tab", its four
          edges each split one way, and both carry `dropLabel`'s own text
          rather than a second copy of what it says. */}
      {edge?.edge === null && (
        <span className="pane__drop">
          <span className="pane__drop-label">{dropLabel(edge)}</span>
        </span>
      )}
      {edge?.edge && (
        <span
          className="pane__drop pane__drop--edge"
          data-dir={edge.edge}
          data-before={edge.before || undefined}
        >
          <span className="pane__drop-label">{dropLabel(edge)}</span>
        </span>
      )}
    </div>
  );
}

function noop() {
  // Default for the optional callbacks a caller (`ToolWindow.tsx`'s own,
  // strip-unaware `renderPanes` call site) does not supply. A pane with no
  // members never reaches these — see the `ownMembers.length > 0` guard
  // above — so this only exists to satisfy the type when `members` is
  // present but a handler for it was, for whatever reason, left off.
}

export type { SplitDir };
