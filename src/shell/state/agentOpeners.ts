/**
 * What the Agents page's rows and `+` buttons do to the window. Kept apart
 * from `WindowRoot` so the cluster and pane handling can be tested without
 * drawing the window.
 *
 * Both park the tab with `focusWhenShown` instead of setting the active pane
 * themselves: a tab in another cluster is not in the tree this window draws
 * until the cluster has switched, and the window's own effect focuses the
 * pane holding it on the render that first shows it.
 */
import type { SplitDir } from "../../bindings";
import { AGENT_TAB_APP } from "./agentBar";

export interface AgentOpeners {
  label: string;
  activeClusterId: string | null;
  activePaneId: string | null;
  hideTakeover: () => void;
  focusWhenShown: (instanceId: string) => void;
  activateInstance: (instanceId: string) => Promise<void>;
  setActiveCluster: (label: string, clusterId: string) => Promise<void>;
  openInstance: (label: string, appId: string, paneId?: string, dir?: SplitDir) => Promise<string>;
  splitDirOnOpen: (paneId: string | null) => SplitDir;
  report: (message: string, err: unknown) => void;
}

/** A row: bring its tab forward, in whichever of this window's clusters it is. */
export function openAgent(w: AgentOpeners, instanceId: string): Promise<void> {
  w.hideTakeover();
  w.focusWhenShown(instanceId);
  return w
    .activateInstance(instanceId)
    .catch((err: unknown) => w.report("kaava: could not bring that agent tab forward:", err));
}

/**
 * A cluster's `+`: a new agent tab there. In the cluster on screen it opens
 * beside the active pane, as any other opener does; in another, that cluster
 * comes forward first and the tab opens in it.
 */
export async function newAgent(w: AgentOpeners, clusterId: string): Promise<void> {
  w.hideTakeover();
  try {
    if (clusterId === w.activeClusterId) {
      w.focusWhenShown(
        await w.openInstance(
          w.label,
          AGENT_TAB_APP,
          w.activePaneId ?? undefined,
          w.splitDirOnOpen(w.activePaneId),
        ),
      );
      return;
    }
    await w.setActiveCluster(w.label, clusterId);
    w.focusWhenShown(await w.openInstance(w.label, AGENT_TAB_APP));
  } catch (err) {
    w.report("kaava: could not open an agent tab:", err);
  }
}
