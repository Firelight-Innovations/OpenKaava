/**
 * The drag layer.
 *
 * One gesture, one payload, and every drop target registered rather than
 * guessed. A tab — app surface or terminal, they no longer differ — drops into
 * a tab strip, onto a pane's edge to split it there, into the terminal panel,
 * or clear of everything to become its own window. A cluster chip drags through
 * the same handle and the same threshold but lands only in the last of those:
 * into the window it was released over, or one of its own. See `commitCluster`.
 *
 * The whole gesture lives here — press-and-hold, movement threshold, and
 * `pointermove`/`pointerup`/`pointercancel` on `window`, as `Frame.tsx` does.
 *
 * What it no longer does is read other regions' markup. The old version found
 * its targets with `document.querySelector('[data-region="panel"]')` and a
 * reorder index from `bar.querySelectorAll(".switcher__tab")` — a query into
 * another region's class names, which could not survive an arbitrary number of
 * panes and strips appearing and disappearing as the user splits things, so
 * targets now register themselves; see `src/shell/dropZones.ts`.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, useMotionValue, useSpring } from "framer-motion";
import type {
  Cluster,
  ClusterDrag,
  DragHandleProps,
  DragPayload,
  DragState,
  DropTarget,
} from "../contract";
import { paneLeaves } from "../contract";
import {
  detachCluster,
  detachInstance,
  moveInstance,
  moveTerminal,
  newClusterForDrop,
  splitPane,
  windowAtCursor,
} from "../state/shellState";
import { sameEnvironment } from "../environment";
import DragGhost from "./DragGhost";
import { ghostSpring } from "./ghostSpring";
import { DetachOutline } from "./DropTargets";
import DropHint from "./DropHint";
import { hitTest } from "../dropZones";
import "./drag.css";

/**
 * How far the pointer has to travel from the press point before a press becomes
 * a drag. Below this it stays a click — every tab spreads this handle's
 * `onPointerDown` alongside its own `onClick` and relies on a press that never
 * moves still selecting the tab.
 */
const PRESS_THRESHOLD = 4;

interface Session {
  payload: DragPayload;
  pointerId: number;
  startX: number;
  startY: number;
  began: boolean;
}

/**
 * `label` and `activeClusterId` are the *destination* half of every commit: a
 * pane belongs to a cluster, and a tab released over another window has to be
 * moved to that window rather than this one. Passed in rather than read from
 * `shell:state` here, since `WindowRoot` has already resolved which cluster
 * this window is showing.
 *
 * `translateStripIndex` is the same kind of borrowed answer, for a narrower
 * question: a `strip` target's `index` is counted over whatever `ClusterBar`
 * actually rendered, which can disagree with the tab's real tree position
 * since Home stopped drawing a tab there. `WindowRoot` is the one place that
 * knows a pane's real order, so this hook only applies its answer once — at
 * the single call in `commit` that writes the index to the backend. The
 * *live* target exposed for `ClusterBar`'s caret stays untranslated on
 * purpose, since the caret must agree with the row on screen.
 *
 * `clusters` is the live list this window is showing, threaded through to
 * `resolve` for one question: whether a `cluster` target's environment
 * agrees with the dragged tab's own (`sameEnvironment`).
 */
export function useDrag(
  label: string,
  activeClusterId: string | null,
  translateStripIndex: (paneId: string, index: number) => number,
  clusters: Cluster[],
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // Written raw on every move and chased by a spring, rather than routed through
  // React state. The ghost has to read as attached to the cursor, and a
  // re-render per frame cannot promise that under load — least of all during a
  // drag, when a re-render also re-measures every pane in the window.
  const rawX = useMotionValue(0);
  const rawY = useMotionValue(0);
  const ghostX = useSpring(rawX, ghostSpring);
  const ghostY = useSpring(rawY, ghostSpring);

  const tabHandle = useCallback(
    (payload: DragPayload): DragHandleProps => ({
      style: { cursor: "grab" },
      onPointerDown: (e: ReactPointerEvent) => {
        // Only the primary button drags. A right-click that started a gesture
        // would leave a ghost stuck to the cursor with no release to end it.
        if (e.button !== 0) return;

        sessionRef.current = {
          payload,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          began: false,
        };

        // Capture keeps the gesture alive when the cursor outruns the tab, which
        // it always does. It is an optimisation rather than the mechanism — the
        // window listeners below are what track the drag — and it throws for a
        // pointer id the browser no longer considers active. Bare, it sat above
        // those listeners, so a throw would abort the handler and lose the drag
        // entirely. Guarded, the worst case is a slightly less forgiving gesture.
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Nothing to do; see above.
        }

        const onMove = (ev: PointerEvent) => {
          const s = sessionRef.current;
          if (!s || ev.pointerId !== s.pointerId) return;

          if (!s.began) {
            const travelled = Math.hypot(ev.clientX - s.startX, ev.clientY - s.startY);
            if (travelled < PRESS_THRESHOLD) return;
            s.began = true;
            // Seeded so the ghost springs from under the cursor rather than
            // flying in from the origin.
            rawX.jump(ev.clientX);
            rawY.jump(ev.clientY);
          }

          rawX.set(ev.clientX);
          rawY.set(ev.clientY);
          const target = resolve(s.payload, ev.clientX, ev.clientY, clusters);
          setDrag({ payload: s.payload, x: ev.clientX, y: ev.clientY, target });
        };

        /**
         * End the gesture and stop listening. Shared by the release and the
         * cancel, which differ only in whether anything is committed.
         *
         * Returns the session the caller should act on, or `null` when this
         * event is not ours to act on — a stray pointer, or a press that never
         * cleared the threshold and was therefore a click.
         */
        const finish = (ev: PointerEvent): Session | null => {
          const s = sessionRef.current;
          sessionRef.current = null;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("keydown", onKeyDown);

          // Cleared before the commit rather than after. The pointer is already
          // up, some commits resolve asynchronously, and nothing about ending
          // the gesture should wait on or race one.
          setDrag(null);
          if (!s || ev.pointerId !== s.pointerId || !s.began) return null;
          return s;
        };

        const onUp = (ev: PointerEvent) => {
          const s = finish(ev);
          if (!s) return;
          commit(
            s.payload,
            resolve(s.payload, ev.clientX, ev.clientY, clusters),
            label,
            activeClusterId,
            translateStripIndex,
            clusters,
          );
        };

        // A cancel is *not* a release, and treating it as one was a real hazard
        // rather than a tidiness point. `pointercancel` fires when something
        // else takes the gesture over — the OS starting a window drag, the
        // capture element going away, a touch turning into a scroll — and it
        // carries the coordinates of wherever the pointer was when that
        // happened, which is not where the user meant to let go. Committing on
        // it dropped the payload at that stale point, and for a cluster that is
        // *silent*: `resolve` turns every target but `detach` into `none`, so a
        // cancel anywhere over a pane or the tab row did nothing at all and left
        // nothing behind to look at. A cancelled gesture puts the thing back
        // where it was, which is what the user will read the disappearing ghost
        // as meaning anyway.
        const onCancel = (ev: PointerEvent) => {
          finish(ev);
        };

        // Board 07's hint bar names this key, so it has to actually work: a
        // hint that promises "Esc cancel" and does nothing on Esc is worse
        // than no hint at all. Listens from the moment the press begins
        // rather than only once `began` flips true, so Escape also cancels a
        // press that has not cleared the move threshold yet — there is no
        // reason a gesture too small to look like a drag should be the one
        // case this key does not reach.
        //
        // Ends the session the same way `finish` does but commits nothing:
        // there is no `PointerEvent` to hand it and nothing to resolve a
        // target from anyway — a cancelled drag puts the thing back where it
        // was, full stop.
        const onKeyDown = (ev: KeyboardEvent) => {
          if (ev.key !== "Escape") return;
          ev.preventDefault();
          sessionRef.current = null;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("keydown", onKeyDown);
          setDrag(null);
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKeyDown);
      },
    }),
    [label, activeClusterId, translateStripIndex, clusters, rawX, rawY],
  );

  const overlay = useMemo(
    () =>
      drag ? (
        <div className="drag-overlay">
          <DragGhost payload={drag.payload} x={ghostX} y={ghostY} />
          <AnimatePresence>
            {drag.target.kind === "detach" && <DetachOutline key="detach" x={ghostX} y={ghostY} />}
          </AnimatePresence>
          <DropHint target={drag.target} x={ghostX} y={ghostY} />
        </div>
      ) : null,
    [drag, ghostX, ghostY],
  );

  // The small, stable surface this hook hands back: one handle factory, one
  // `overlay` node for `FrameSlots.overlay`, and the live drop target.
  // `WindowRoot` wires all three into the panes and the panel.
  return {
    tabHandle,
    overlay,
    dragging: drag !== null,
    /** So a pane can draw its own indicator. Null when nothing is in the air. */
    target: drag?.target ?? null,
  };
}

/**
 * Where *this* payload would land, which is not always what is under the cursor.
 *
 * The zones answer for a tab, since a tab is what they were registered for. A
 * cluster can only be released on a window — it holds panes and cannot go
 * inside a pane or a panel — so `none` is substituted over those targets
 * rather than drawing an indicator for a release `commitCluster` would refuse.
 *
 * A `cluster` target's `refused` is computed here too, and only here:
 * `hitTest` cannot know it, and `dropLabel`/`commit` both read the value
 * stamped here rather than recomputing it, so the hint bar and the actual
 * drop can never disagree about whether a release will do anything.
 */
function resolve(payload: DragPayload, x: number, y: number, clusters: Cluster[]): DropTarget {
  const target = hitTest(x, y);
  if (payload.what === "cluster") {
    return target.kind === "detach" ? target : { kind: "none" };
  }
  if (target.kind !== "cluster") return target;
  return { ...target, refused: clusterDropRefused(payload, target.clusterId, clusters) };
}

/**
 * Whether releasing a tab on this cluster chip would do anything.
 *
 * Two ways to be refused: the chip is the cluster the tab is already in — the
 * strip is what reorders within a cluster, and a chip has no pane of its own
 * to say *where* in that cluster the tab would land, so "move to the cluster
 * you're already showing" is not a question this gesture can answer — or the
 * two clusters are in different environments, which is KAAVA-UX-REWORK.md
 * §5's stated rule in full: "Tabs can only move between clusters that share
 * an environment."
 */
function clusterDropRefused(
  payload: DragPayload,
  toClusterId: string,
  clusters: Cluster[],
): boolean {
  if (payload.what !== "surface") return true;
  if (payload.fromClusterId === toClusterId) return true;
  const from = clusters.find((c) => c.id === payload.fromClusterId) ?? null;
  const to = clusters.find((c) => c.id === toClusterId) ?? null;
  return !sameEnvironment(from, to);
}

/**
 * Every backend call a release makes goes through here.
 *
 * These used to be bare `void invoke(...)`, and a rejected one went nowhere at
 * all — `void` on a promise discards the rejection as deliberately as it
 * discards the value. That is survivable for a call that cannot fail and
 * indefensible for these: a drop is the one gesture in the shell with no visible
 * confirmation when it succeeds, so a drop that fails and a drop that worked
 * look identical, and the first thing anyone would want on being told "dragging
 * a cluster out does nothing" is whether the backend was even asked. It is a
 * console line rather than anything on screen because a refused drop is not a
 * state the user has to act on — the thing they dragged is still exactly where
 * it was — but there has to be *something*.
 */
function attempt(what: string, work: Promise<unknown>): void {
  void work.catch((e: unknown) => {
    console.error(`kaava: ${what} failed`, e);
  });
}

/**
 * Act on a release.
 *
 * Split out of the handler so the mapping from target to call is one readable
 * table rather than a branch buried in a closure — this is the part someone
 * changing the gesture will come looking for.
 */
function commit(
  payload: DragPayload,
  target: DropTarget,
  label: string,
  activeClusterId: string | null,
  translateStripIndex: (paneId: string, index: number) => number,
  clusters: Cluster[],
): void {
  if (payload.what === "cluster") return commitCluster(payload, target, label);

  switch (target.kind) {
    case "strip":
      if (activeClusterId) {
        attempt(
          `moving ${payload.instanceId} into ${target.paneId}`,
          moveInstance(
            payload.instanceId,
            activeClusterId,
            target.paneId,
            // The index the row measured, translated back to the pane's real
            // tab order — see `useDrag`'s doc comment for why the two can
            // differ now that Home hides from the strip without leaving the
            // tree.
            translateStripIndex(target.paneId, target.index),
          ),
        );
      }
      return;

    case "pane":
      if (target.edge) {
        attempt(
          `splitting ${target.paneId} for ${payload.instanceId}`,
          splitPane(target.paneId, target.edge, payload.instanceId, target.before),
        );
      } else if (activeClusterId) {
        attempt(
          `moving ${payload.instanceId} into ${target.paneId}`,
          moveInstance(payload.instanceId, activeClusterId, target.paneId, null),
        );
      }
      return;

    case "panel":
      // Only a terminal can live in the panel. An app surface dropped there is a
      // no-op rather than an error: the panel holds terminals and the git view,
      // and there is nothing sensible for it to do with a Files. Refusing
      // silently leaves the tab where it was, which is what a cancelled drag
      // should look like.
      if (payload.kind === "terminal") {
        attempt(
          `moving ${payload.instanceId} into ${label}'s panel`,
          moveTerminal(payload.instanceId, label),
        );
      }
      return;

    case "detach":
      // Released over no registered target. Which window that is over decides
      // nothing here, and deliberately: `window_at_cursor` answers with a label
      // and nothing else — it hit-tests window rectangles, so it cannot say
      // *where inside* another window the cursor was. Guessing a pane would drop
      // the tab somewhere the user did not aim, so a release over another window
      // detaches into a new one just as a release over the desktop does. Moving
      // into a specific pane of another window needs a richer hit-test that
      // returns window-local coordinates; that is the follow-up.
      //
      // The call is still made, because it is the only way to distinguish "over
      // no OpenKaava window" from "over one, outside its targets" in the log when
      // this behaviour is revisited.
      attempt(
        `detaching ${payload.instanceId} into a window of its own`,
        windowAtCursor().then(() => detachInstance(payload.instanceId)),
      );
      return;

    case "cluster":
      // `refused` was computed once, in `resolve`, off the same
      // `clusterDropRefused` this would otherwise have to recompute — see
      // that function's doc comment for why staying refused here is what
      // keeps the hint bar and the actual drop from disagreeing.
      if (target.refused) {
        console.debug(
          `kaava: ${payload.instanceId} released over cluster ${target.clusterId}, refused`,
        );
        return;
      }
      {
        // A chip names a cluster, not a pane — `move_instance` needs one, so
        // this picks that cluster's own first pane in layout order. Any pane
        // in the cluster is as good a landing spot as any other for a drop
        // that named the *cluster*, not a place inside it; a strip or a
        // pane's own edge is how you aim more precisely than that.
        const cluster = clusters.find((c) => c.id === target.clusterId);
        const pane = cluster && paneLeaves(cluster.tree)[0];
        if (pane) {
          attempt(
            `moving ${payload.instanceId} into cluster ${target.clusterId}`,
            moveInstance(payload.instanceId, target.clusterId, pane.id, null),
          );
        }
      }
      return;

    case "new-cluster":
      // `fromClusterId` is the environment `new_cluster_for_drop` clones —
      // see `ShellState::add_cluster_for_environment`. Only `null` for a
      // page's surface, which `dragHandleFor` never offers a handle for, so
      // this is guarded rather than asserted: a payload that somehow lacks
      // it is a drop that does nothing, not a crash.
      if (payload.fromClusterId) {
        attempt(
          `opening a new cluster for ${payload.instanceId}`,
          newClusterForDrop(label, "New cluster", payload.fromClusterId, payload.instanceId),
        );
      }
      return;

    case "none":
      // Unreachable for a tab: `resolve` substitutes this for a cluster and for
      // nothing else. Spelled out rather than left to fall off the end of the
      // switch, so this table stays a complete list of what a release can mean.
      return;
  }
}

/**
 * The same release, for a cluster.
 *
 * Only two targets can reach here, because `resolve` has already turned every
 * strip, pane and panel a cluster was released over into `none` — see it for
 * why. `none` does nothing at all: the cluster stays exactly where it was, which
 * is what a cancelled drag looks like, and is better than inventing a meaning
 * for a gesture the user cannot have intended.
 *
 * So `detach` is the one that acts, and unlike a tab's `detach` it uses the
 * answer it is given — see the two branches at the `attempt` below.
 */
function commitCluster(payload: ClusterDrag, target: DropTarget, label: string): void {
  if (target.kind !== "detach") {
    // The one branch in the whole gesture that is meant to do nothing, and
    // therefore the one that is impossible to tell apart from the gesture being
    // broken. "Dragging a cluster out does nothing" was reported against a build
    // where this line did not exist, and answering it meant reading every step
    // of the path from the chip to `windows::create` because there was no way to
    // find out from the outside which of them had declined. `debug` rather than
    // `warn`: declining is correct here, and it should not read as a fault in a
    // console someone is using for something else.
    console.debug(`kaava: cluster ${payload.clusterId} released over ${target.kind}, staying put`);
    return;
  }

  // **Over another OpenKaava window** — the cluster moves into it. This is built
  // here where the same drop for a single tab was deliberately not, and the
  // difference is real rather than an inconsistency somebody forgot to fix. A
  // tab needs a *pane* to land in, and `window_at_cursor` returns a label — it
  // hit-tests window rectangles and cannot say where inside one the cursor was,
  // so a pane would have to be guessed. A cluster is appended to that window's
  // cluster list; the label is the whole of the address. The same reasoning is
  // written at `commands::detach_cluster`, on the other side.
  //
  // **Over this window, or over nothing** — a window of its own. Releasing over
  // the window it came from is not treated as "put it back where it was": the
  // whole row is a drop zone, so a release that reaches `detach` at all is one
  // that missed the bar on purpose.
  attempt(
    `dropping ${payload.clusterId} out of ${label}`,
    windowAtCursor().then((over) =>
      detachCluster(payload.clusterId, over && over !== label ? over : null),
    ),
  );
}
