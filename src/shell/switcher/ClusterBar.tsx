import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Cluster, DragHandleProps, ToolHealth, ToolPresentation } from "../contract";
import { environmentOf, ENVIRONMENT_LABEL, type EnvironmentKind } from "../environment";
import { instant, instantOut, snap } from "../motion";
import { useDropZone } from "../dropZones";
import { Cloud, GitBranch, Lock, Pin } from "lucide-react";
import { Close, Plus, Search, WarningTriangle } from "../../ui/Icon";
import OverlayScrollbar from "../OverlayScrollbar";
import HealthPopover, { type UnhealthyTool } from "./HealthPopover";
import "./switcher.css";

/**
 * The one tab bar — cluster tabs, and nothing else.
 *
 * `docs/design/KAAVA-UX-SPEC.md` §1.3: "cluster tabs only". Gone from here,
 * not hidden: a cluster's member tabs (the **panes** workstream gives each
 * pane its own strip instead), page chips (the **rail** workstream's
 * `src/shell/rail/Rail.tsx` takes them; the old `PageChips.tsx` is gone), and
 * the switcher-row "open an app" button (still reachable through the title
 * bar's Apps menu, `src/shell/appsMenu.ts`).
 *
 * Added instead: what a *tab* needs to say about an environment rather than
 * a group of tabs — an environment chip (`environmentOf`, §1.3's
 * `wt`/`cloud`/`main` glyphs) and a registration point (`data-cluster-id` +
 * `clusterTabRef`) the **panes** workstream's cluster drop zone reads.
 */
export interface ClusterBarProps {
  clusters: Cluster[];
  activeClusterId: string | null;
  onSelect: (clusterId: string) => void;
  onAdd: () => void;
  onClose: (clusterId: string) => void;
  onRename: (clusterId: string, name: string) => void;
  /**
   * The chip's own drag handle: the gesture that pulls a whole cluster out of
   * this window and into another, tree and all. Offered on every chip,
   * including the last one — see `ClusterTab`'s `closable` comment, which
   * gives the same reasoning for the close button.
   */
  dragHandleForCluster?: (cluster: Cluster) => DragHandleProps | undefined;
  /**
   * A registration point on each cluster tab's own DOM node, for the
   * **panes** workstream's cluster drop zone — dropping a pane's tab onto a
   * cluster chip that isn't the open one. Called with the cluster id; returns
   * the ref callback to attach to that chip. Omitted, no ref is attached and
   * nothing about the tab's own behaviour changes.
   */
  clusterTabRef?: (clusterId: string) => (el: HTMLDivElement | null) => void;
  /**
   * What the warning badge reports on. Deliberately *not* per-cluster: whether
   * a tool needs an update is a property of the stack and has nothing to do
   * with which cluster is open.
   */
  healthOf?: ToolPresentation[];
  onRescan: () => void;
  searchSlot?: ReactNode;
  /** True while the search field is expanded. The bar yields its width to it. */
  searchExpanded?: boolean;
}

function isUnhealthy(tool: ToolPresentation): tool is UnhealthyTool {
  return tool.health !== ("ok" satisfies ToolHealth);
}

/**
 * How a chip arrives and leaves.
 *
 * Opacity only, and no `y` or `x`: this row is a horizontal scroll container,
 * and an element that animated out sideways would extend its scroll range for
 * as long as the exit ran — a scrollbar that flashes under the tabs every time
 * one closes. The *movement* in an arrival or a departure is not this
 * element's at all, it is everything beside it sliding over to make room or
 * close the gap, which `layout="position"` does without anything having to
 * travel.
 */
const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: instant },
  exit: { opacity: 0, transition: instantOut },
};

const KIND_ICON: Record<EnvironmentKind, typeof GitBranch> = {
  worktree: GitBranch,
  design: GitBranch,
  cloud: Cloud,
  main: Lock,
};

export default function ClusterBar({
  clusters,
  activeClusterId,
  onSelect,
  onAdd,
  onClose,
  onRename,
  dragHandleForCluster,
  clusterTabRef,
  healthOf,
  onRescan,
  searchSlot,
  searchExpanded = false,
}: ClusterBarProps) {
  const [healthOpen, setHealthOpen] = useState(false);
  const badgeWrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const unhealthy = (healthOf ?? []).filter(isUnhealthy);

  // Board 07's fifth zone: drop on empty switcher space opens a new cluster
  // holding the dragged tab, in the source cluster's own environment — see
  // `useDrag`'s "new-cluster" case. Registered on the whole bar rather than
  // some carved-out empty stretch of it: `hitTest`'s pass order checks the
  // strip zones (now on each pane's own `PaneTabStrip`) and the cluster chips
  // (below) first, so this only ever wins when the pointer is over neither,
  // which is exactly "empty switcher space" without this component having to
  // compute where that is. Registered unconditionally — a window with no
  // clusters at all still has to accept this drop.
  const switcherZone = useDropZone({ kind: "switcher" });

  // Dismiss like every other popover in the shell: a click outside, or Escape.
  useEffect(() => {
    if (!healthOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!badgeWrapRef.current?.contains(e.target as Node)) setHealthOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHealthOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [healthOpen]);

  // The badge disappears the moment the field expands, so a popover left open
  // behind it would be unreachable and orphaned.
  useEffect(() => {
    if (searchExpanded) setHealthOpen(false);
  }, [searchExpanded]);

  // The pinned Design canvas cluster (if one exists) comes first, set off from
  // the rest by a divider — §1.3. Detected the same way `environment.ts` does
  // it everywhere else: by branch name, since `Cluster` has no `pinned` flag
  // yet. One derivation, so the swap to a real flag is this line, not every
  // caller of it.
  const { design, rest } = useMemo(() => {
    const design = clusters.find((c) => environmentOf(c).kind === "design") ?? null;
    const rest = design ? clusters.filter((c) => c.id !== design.id) : clusters;
    return { design, rest };
  }, [clusters]);

  return (
    <div className="switcher" ref={switcherZone}>
      <div
        className={`switcher__tabs${searchExpanded ? " switcher__tabs--collapsed" : ""}`}
        ref={rowRef}
      >
        {design && (
          <>
            <ClusterTab
              cluster={design}
              active={design.id === activeClusterId}
              pinned
              dragHandle={dragHandleForCluster?.(design)}
              tabRef={clusterTabRef?.(design.id)}
              onSelect={onSelect}
              onClose={onClose}
              onRename={onRename}
            />
            <span className="switcher__divider" aria-hidden="true" />
          </>
        )}

        <AnimatePresence initial={false}>
          {rest.map((cluster) => (
            <motion.div key={cluster.id} layout="position" transition={snap} {...fade}>
              <ClusterTab
                cluster={cluster}
                active={cluster.id === activeClusterId}
                // Always closable and always draggable, including the last one
                // — a window with no cluster is a real state, and the
                // multi-monitor drag gesture should not vanish just because a
                // window happens to hold one cluster, the commonest case there
                // is. See `move_cluster_pure` in `shell_state.rs`.
                dragHandle={dragHandleForCluster?.(cluster)}
                tabRef={clusterTabRef?.(cluster.id)}
                onSelect={onSelect}
                onClose={onClose}
                onRename={onRename}
              />
            </motion.div>
          ))}
        </AnimatePresence>

        <motion.button
          type="button"
          className="switcher__newbtn"
          layout="position"
          transition={snap}
          onClick={onAdd}
          aria-label="New cluster"
        >
          <Plus />
        </motion.button>
      </div>

      <OverlayScrollbar targetRef={rowRef} />

      <div className={`switcher__spacer${searchExpanded ? " switcher__spacer--collapsed" : ""}`} />

      {!searchExpanded && unhealthy.length > 0 && (
        <div className="switcher__badge-wrap" ref={badgeWrapRef}>
          <button
            type="button"
            className="switcher__badge"
            aria-expanded={healthOpen}
            onClick={() => setHealthOpen((open) => !open)}
          >
            <WarningTriangle size={12} className="switcher__badge-icon" />
            <span className="switcher__badge-count">{unhealthy.length}</span>
          </button>
          <AnimatePresence>
            {healthOpen && (
              <HealthPopover
                tools={unhealthy}
                onRescan={() => {
                  onRescan();
                  setHealthOpen(false);
                }}
              />
            )}
          </AnimatePresence>
        </div>
      )}

      {searchSlot ?? (
        <div className="switcher__search-default">
          <Search size={14} className="switcher__search-icon" />
          <span className="switcher__search-label">Search</span>
          <span className="switcher__search-hint">Ctrl+K</span>
        </div>
      )}
    </div>
  );
}

/**
 * One cluster's tab: an environment chip, its name (renameable in place), and
 * a close button.
 *
 * A `div role="tab"` rather than a `<button>`, for the reason this always was:
 * a button may not legally contain another button, and this needs to nest a
 * close ×. Keyboard access is put back by hand rather than lost with the
 * element.
 *
 * It is also a drag source: dragged clear of the bar, the whole cluster moves
 * to another window, which is what a second monitor is for.
 */
function ClusterTab({
  cluster,
  active,
  pinned = false,
  dragHandle,
  tabRef,
  onSelect,
  onClose,
  onRename,
}: {
  cluster: Cluster;
  active: boolean;
  /** The Design canvas cluster, §1.3 — draws the pin glyph after the env chip. */
  pinned?: boolean;
  dragHandle?: DragHandleProps;
  tabRef?: (el: HTMLDivElement | null) => void;
  onSelect: (clusterId: string) => void;
  onClose: (clusterId: string) => void;
  onRename: (clusterId: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cluster.name);

  // A drop target of its own, for "drop a tab onto a cluster chip moves it
  // into that cluster" (board 07, and `useDrag`'s `clusterDropRefused`).
  // `data-cluster-id` alongside it is not read by any drop-zone code — the
  // registry already has the element, keyed by `clusterId` above — it exists
  // so the chip itself, and a test, can name which cluster a given DOM node
  // is.
  const clusterZone = useDropZone({ kind: "cluster", clusterId: cluster.id });

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // An empty name is a name you cannot click on. Refused by restoring what
    // was there rather than by rejecting the edit with a message, since there
    // is nothing the user needs to be told: the tab simply keeps its name.
    if (next && next !== cluster.name) onRename(cluster.id, next);
    else setDraft(cluster.name);
  };

  const env = environmentOf(cluster);
  const Glyph = KIND_ICON[env.kind];

  const missing = cluster.environmentMissing === true;
  const classes = ["switcher__tab"];
  if (active) classes.push("switcher__tab--active");
  if (missing) classes.push("switcher__tab--missing");

  return (
    <div
      // Two registrations on one node: `clusterZone` is this chip's own drop
      // target (above), `tabRef` is the external hook `ClusterBarProps`
      // documents for whatever else needs this DOM node by cluster id.
      // Composed rather than picking one — neither loses the element.
      ref={(el) => {
        clusterZone(el);
        tabRef?.(el);
      }}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={classes.join(" ")}
      title={
        missing
          ? `${cluster.name} — its worktree folder is missing on disk${
              cluster.environment && "path" in cluster.environment
                ? `: ${cluster.environment.path}`
                : ""
            }`
          : cluster.name
      }
      data-cluster-id={cluster.id}
      onClick={() => onSelect(cluster.id)}
      onDoubleClick={() => {
        setDraft(cluster.name);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(cluster.id);
        }
      }}
      // Not while renaming. The field below is inside this element, so a press
      // in it to select some text is a press on the chip, and dragging across
      // a few characters would clear the threshold and pull the cluster out
      // of the window mid-edit.
      onPointerDown={editing ? undefined : dragHandle?.onPointerDown}
      style={editing ? undefined : dragHandle?.style}
    >
      {/* The environment chip — `wt`/`cloud`/`main`/`design`, §1.3. A real
          derivation off the cluster's own worktree/project fields
          (`environment.ts`), never a placeholder: a cluster with no worktree
          reads as `main` here exactly as honestly as it does everywhere else
          this shell says so. */}
      <span className="switcher__tab-env" data-env-kind={env.kind}>
        <Glyph size={10} strokeWidth={1.5} className="switcher__tab-env-icon" />
        {ENVIRONMENT_LABEL[env.kind]}
      </span>

      {missing && (
        <WarningTriangle
          size={12}
          className="switcher__tab-missing-icon"
          aria-label="Worktree folder missing"
        />
      )}

      {pinned && (
        <Pin size={12} strokeWidth={1.5} className="switcher__tab-pin" aria-hidden="true" />
      )}

      {editing ? (
        <input
          className="switcher__tab-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Stopped from reaching the tab's own handler, which would
            // otherwise treat Enter and Space as "select this tab" while you
            // are typing.
            e.stopPropagation();
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(cluster.name);
              setEditing(false);
            }
          }}
          // A click inside the field must not re-select the tab or, worse,
          // re-enter editing on the second click of a double.
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="switcher__tab-label">{cluster.name}</span>
      )}

      <button
        type="button"
        className="switcher__tab-close"
        aria-label={`Close ${cluster.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(cluster.id);
        }}
        // Without this, pressing the × would begin whatever gesture the tab
        // itself starts on pointerdown.
        onPointerDown={(e) => e.stopPropagation()}
        style={editing ? { display: "none" } : undefined}
      >
        <Close />
      </button>
    </div>
  );
}
