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
import { NO_SESSION, type AgentCluster, type AgentSession } from "./agentSessions";
import { AGENT_TAB_APP } from "./agentTab";

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
  /** Open saved session `sessionId` in agent tab `instanceId` (`agent-tab/history-open`). */
  resume: (instanceId: string, sessionId: string) => Promise<unknown>;
  report: (message: string, err: unknown) => void;
}

/** A row: bring its tab forward, in whichever of this window's clusters it is. */
export function openAgent(w: AgentOpeners, instanceId: string): Promise<void> {
  w.hideTakeover();
  w.focusWhenShown(instanceId);
  return w
    .activateInstance(instanceId)
    .catch((err: unknown) => w.report("veistra: could not bring that agent tab forward:", err));
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
    w.report("veistra: could not open an agent tab:", err);
  }
}

/** The first of `cluster`'s agent tabs that has never sent a prompt, or `null`. */
export function emptyAgentTab(
  cluster: AgentCluster | undefined,
  sessions: ReadonlyMap<string, AgentSession>,
): string | null {
  const empty = cluster?.tabs.find((tab) => {
    const session = sessions.get(tab.id) ?? NO_SESSION;
    return session.state === "none" && session.prompt === null;
  });
  return empty?.id ?? null;
}

/**
 * A previous session's row: open it in `emptyTab`, an agent tab in the
 * cluster on screen that has never sent a prompt, or else in a new agent tab
 * beside the active pane. The backend restores it into that tab and tells
 * the tab, which attaches again and shows it.
 */
export async function resumeAgent(
  w: AgentOpeners,
  sessionId: string,
  emptyTab: string | null,
): Promise<void> {
  w.hideTakeover();
  try {
    let tab = emptyTab;
    if (tab === null) {
      tab = await w.openInstance(
        w.label,
        AGENT_TAB_APP,
        w.activePaneId ?? undefined,
        w.splitDirOnOpen(w.activePaneId),
      );
      w.focusWhenShown(tab);
    } else {
      w.focusWhenShown(tab);
      await w.activateInstance(tab);
    }
    await w.resume(tab, sessionId);
  } catch (err) {
    w.report("veistra: could not resume that agent session:", err);
  }
}
