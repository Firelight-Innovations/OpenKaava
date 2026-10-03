/**
 * The cluster strip: one small badge per cluster, at the top of the right rail.
 * The other half of what the cluster tab bar used to be. The title bar's pill
 * dropdown (`ClusterSwitcher`) is the complete list; this is the always-visible,
 * one-click version of it, sized to sit in the rail's 44px column above the page
 * icons and to cost no height.
 *
 * Everything a tab did is still reachable from a badge:
 *  - click switches, and clicking the open one toggles the Home cover, exactly
 *    as the tab did (`onSelect` is the same handler);
 *  - drag pulls the whole cluster into another window (`dragHandle`);
 *  - dropping a pane tab on it moves the tab there (the `cluster` drop zone);
 *  - the right-click menu carries switch, rename and close, which the tab had as
 *    a click, a double-click and a ×;
 *  - empty strip space is the `switcher` drop zone: drop a tab there and it
 *    opens a new cluster in the same environment.
 * There is no drag-to-reorder. The tab bar never had it — its drag gesture moves
 * a cluster *between windows* — so the strip does not invent it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { Cluster, DragHandleProps } from "../contract";
import { environmentOf } from "../environment";
import { useDropZone } from "../dropZones";
import { placeMenu, type Point } from "../contextMenu";
import MenuItemList, { inMenuSurface } from "../MenuItemList";
import { popover } from "../motion";
import { Plus } from "../../ui/Icon";
import ClusterChip from "../ClusterChip";
import {
  clusterMenuItems,
  clusterTooltip,
  needsAttention,
  type ClusterMenuActions,
  type ClusterTerminal,
} from "../clusterList";
import "../contextMenu.css";
import "./clusterStrip.css";

export interface ClusterStripProps extends ClusterMenuActions {
  /** In display order (`orderClusters`). */
  clusters: Cluster[];
  activeClusterId: string | null;
  terminals: ClusterTerminal[];
  onAdd: () => void;
  /** The gesture that pulls a cluster into another window. */
  dragHandleForCluster?: (cluster: Cluster) => DragHandleProps | undefined;
  /** A registration point on each badge, for whatever needs the node by cluster id. */
  clusterTabRef?: (clusterId: string) => (el: HTMLElement | null) => void;
}

export default function ClusterStrip(props: ClusterStripProps) {
  const { clusters, activeClusterId, terminals, onAdd, dragHandleForCluster, clusterTabRef } =
    props;
  const [menu, setMenu] = useState<{ cluster: Cluster; at: Point } | null>(null);

  // Empty strip space: a tab dropped here opens a new cluster. Registered on the
  // whole strip because `hitTest` checks the badges' own `cluster` zones first,
  // so this only wins where the pointer is over none of them.
  const stripZone = useDropZone({ kind: "switcher" });

  return (
    <nav className="clusterstrip" aria-label="Clusters" ref={stripZone}>
      <div className="clusterstrip__list">
        {clusters.map((cluster) => (
          <Badge
            key={cluster.id}
            cluster={cluster}
            active={cluster.id === activeClusterId}
            attention={needsAttention(cluster.id, activeClusterId, terminals)}
            dragHandle={dragHandleForCluster?.(cluster)}
            tabRef={clusterTabRef?.(cluster.id)}
            onSelect={props.onSelect}
            onContextMenu={(at) => setMenu({ cluster, at })}
          />
        ))}
      </div>

      <button
        type="button"
        className="clusterstrip__add"
        aria-label="New cluster"
        title="New cluster (Ctrl+Shift+N)"
        onClick={onAdd}
      >
        <Plus />
      </button>

      <span className="clusterstrip__divider" aria-hidden="true" />

      <ClusterContextMenu opened={menu} actions={props} onClose={() => setMenu(null)} />
    </nav>
  );
}

function Badge({
  cluster,
  active,
  attention,
  dragHandle,
  tabRef,
  onSelect,
  onContextMenu,
}: {
  cluster: Cluster;
  active: boolean;
  attention: boolean;
  dragHandle?: DragHandleProps;
  tabRef?: (el: HTMLElement | null) => void;
  onSelect: (clusterId: string) => void;
  onContextMenu: (at: Point) => void;
}) {
  // This badge as a drop target: a pane tab released on it moves into the
  // cluster (`useDrag`'s `clusterDropRefused` decides whether that is allowed).
  const clusterZone = useDropZone({ kind: "cluster", clusterId: cluster.id });
  const env = environmentOf(cluster);
  const missing = cluster.environmentMissing === true;

  const handleContextMenu = (e: MouseEvent) => {
    // Claims the right-click, which is what tells `ContextMenuHost` to stand
    // down rather than draw its edit menu over this one.
    e.preventDefault();
    onContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <button
      ref={(el) => {
        clusterZone(el);
        tabRef?.(el);
      }}
      type="button"
      className="clusterstrip__badge"
      data-cluster-id={cluster.id}
      data-env-kind={env.kind}
      data-active={active || undefined}
      data-missing={missing || undefined}
      aria-label={`${cluster.name}, ${clusterTooltip(cluster)}`}
      aria-current={active ? "true" : undefined}
      title={clusterTooltip(cluster)}
      onClick={() => onSelect(cluster.id)}
      onContextMenu={handleContextMenu}
      onPointerDown={dragHandle?.onPointerDown}
      style={dragHandle?.style}
    >
      <ClusterChip cluster={cluster} className="clusterstrip__mono" />
      {attention && (
        <span
          className="clusterstrip__dot"
          role="img"
          aria-label="An agent finished in this cluster"
        />
      )}
      {missing && <span className="clusterstrip__warn" aria-hidden="true" />}
    </button>
  );
}

/**
 * The badge's right-click menu, on the shell's own menu surface.
 *
 * `ContextMenuHost` is the document's edit-menu (cut, copy, paste) and takes its
 * rows from what the click landed in; this is a different menu for a different
 * subject, so it does not go through it. It reuses the *surface* — the
 * `.context-menu` box, `MenuItemList`'s rows (including its rename prompt),
 * `placeMenu`'s flip-and-clamp — so it looks and behaves like every other menu
 * here, and dismisses the way `ContextMenuHost` does.
 */
function ClusterContextMenu({
  opened,
  actions,
  onClose,
}: {
  opened: { cluster: Cluster; at: Point } | null;
  actions: ClusterMenuActions;
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
          aria-label={`${opened.cluster.name} actions`}
          tabIndex={-1}
          style={{ top: at.y, left: at.x }}
          variants={popover}
          initial="initial"
          animate="animate"
          exit="exit"
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuItemList items={clusterMenuItems(opened.cluster, actions)} onAfterSelect={onClose} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
