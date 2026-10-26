/**
 * The cluster list at the top of the right rail: a CLUSTERS heading, one row per
 * cluster (its mark, its name and its branch), and under each row the agent
 * tabs open in it. The other half of what the cluster tab bar used to be. The
 * title bar's pill dropdown (`ClusterSwitcher`) is the complete list; this is
 * the always-visible, one-click version of it.
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
import { useCallback, useState, type MouseEvent } from "react";
import { PanelRight } from "lucide-react";
import type { Cluster, DragHandleProps } from "../contract";
import { environmentOf } from "../environment";
import type { AgentSessionState } from "../state/agentSessions";
import { useDropZone } from "../dropZones";
import type { Point } from "../contextMenu";
import ContextMenuSurface, { type OpenContextMenu } from "../ContextMenuSurface";
import { useAgentMenu } from "../useAgentMenu";
import type { AgentMenuActions } from "../agentMenuItems";
import { Plus } from "../../ui/Icon";
import ClusterChip from "../ClusterChip";
import {
  branchLabel,
  clusterMenuItems,
  clusterTooltip,
  needsAttention,
  type ClusterMenuActions,
  type ClusterTerminal,
} from "../clusterList";
import "./clusterStrip.css";

/** One agent tab under its cluster's row. */
export interface StripAgent {
  id: string;
  /** What the row says: the latest prompt, else the tab's title. */
  label: string;
  /** The name the session was given, if any; the rename field starts from it. */
  name?: string | null;
  state: AgentSessionState;
}

export interface ClusterStripProps extends ClusterMenuActions {
  /** In display order (`orderClusters`). */
  clusters: Cluster[];
  activeClusterId: string | null;
  terminals: ClusterTerminal[];
  /** Each cluster's open agent tabs, by cluster id. A cluster with none shows no list. */
  agents?: ReadonlyMap<string, readonly StripAgent[]>;
  /** Whether the list is folded away. It draws nothing and gives its column back. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Bring an agent tab forward, in whichever cluster holds it. */
  onOpenAgent?: (instanceId: string) => void;
  /** What the right-click menu on an agent row may do; omitted, its rows are disabled. */
  agentMenu?: AgentMenuActions;
  onAdd: () => void;
  /** The gesture that pulls a cluster into another window. */
  dragHandleForCluster?: (cluster: Cluster) => DragHandleProps | undefined;
  /** A registration point on each badge, for whatever needs the node by cluster id. */
  clusterTabRef?: (clusterId: string) => (el: HTMLElement | null) => void;
}

export default function ClusterStrip(props: ClusterStripProps) {
  const {
    clusters,
    activeClusterId,
    terminals,
    agents,
    collapsed = false,
    onToggleCollapsed,
    onOpenAgent,
    agentMenu: agentMenuActions,
    onAdd,
    dragHandleForCluster,
    clusterTabRef,
  } = props;
  // Built when the click lands, so a re-render under an open menu does not move it.
  const [menu, setMenu] = useState<OpenContextMenu | null>(null);
  const agentMenu = useAgentMenu(agentMenuActions);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Empty strip space: a tab dropped here opens a new cluster. Registered on the
  // whole strip because `hitTest` checks the badges' own `cluster` zones first,
  // so this only wins where the pointer is over none of them.
  const stripZone = useDropZone({ kind: "switcher" });

  return (
    <nav
      className="clusterstrip"
      aria-label="Clusters"
      ref={stripZone}
      data-collapsed={collapsed || undefined}
    >
      <div className="clusterstrip__head">
        <h2 className="clusterstrip__heading">Clusters</h2>
        {onToggleCollapsed && (
          <button
            type="button"
            className="clusterstrip__fold"
            aria-label="Hide clusters"
            title="Hide clusters (Ctrl+B)"
            onClick={onToggleCollapsed}
          >
            <PanelRight size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="clusterstrip__list">
        {clusters.map((cluster) => {
          const open = agents?.get(cluster.id) ?? [];
          return (
            <div key={cluster.id} className="clusterstrip__group">
              <Badge
                cluster={cluster}
                active={cluster.id === activeClusterId}
                attention={needsAttention(cluster.id, activeClusterId, terminals)}
                dragHandle={dragHandleForCluster?.(cluster)}
                tabRef={clusterTabRef?.(cluster.id)}
                onSelect={props.onSelect}
                onContextMenu={(at) =>
                  setMenu({
                    at,
                    label: `${cluster.name} actions`,
                    items: clusterMenuItems(cluster, props),
                  })
                }
              />
              {open.length > 0 && (
                <ul className="clusterstrip__agents" aria-label={`${cluster.name} agents`}>
                  {open.map((agent) => (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className="clusterstrip__agent"
                        data-state={agent.state}
                        title={agent.label}
                        onClick={() => onOpenAgent?.(agent.id)}
                        onContextMenu={agentMenu.open({
                          kind: "open",
                          id: agent.id,
                          name: agent.name ?? null,
                        })}
                      >
                        <span className="clusterstrip__agentdot" aria-hidden="true" />
                        <span className="clusterstrip__agentname">{agent.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="clusterstrip__add"
        aria-label="New cluster"
        title="New cluster (Ctrl+Shift+N)"
        onClick={onAdd}
      >
        <Plus />
        <span>New cluster</span>
      </button>

      <ContextMenuSurface opened={menu} onClose={closeMenu} />
      {agentMenu.menu}
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
      <span className="clusterstrip__name">{cluster.name}</span>
      <span className="clusterstrip__branch">{branchLabel(cluster)}</span>
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
