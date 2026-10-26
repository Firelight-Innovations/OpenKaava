/**
 * The agent tab, as the shell sees it: which app it is, where a cluster keeps
 * one, and the questions the shell asks on its behalf.
 */
import { useEffect } from "react";
import { appCall, onAgentTabEvent, onSettingsChanged } from "../../bindings";
import { paneLeaves, type PaneNode } from "../contract";

/** Mirrors `apps::agent_tab::ID`: the app every agent session runs in. */
export const AGENT_TAB_APP = "agent-tab";

/** The first agent tab in a cluster's tree, in layout order, or `null`. */
export function agentTabIn(
  tree: PaneNode,
  instances: ReadonlyMap<string, { appId: string }>,
): string | null {
  for (const leaf of paneLeaves(tree)) {
    const tab = leaf.tabs.find((id) => instances.get(id)?.appId === AGENT_TAB_APP);
    if (tab !== undefined) return tab;
  }
  return null;
}

/**
 * Asks `agent-tab/harnesses` as `agentTab` whenever something the tab cannot
 * see changes: a setting, the cluster's environment, or a status or reset from
 * its own session.
 *
 * The tab asks only when it mounts, chooses, retries a failed ask, or hears its
 * models are in, and a frame is never sent settings. Asked as the tab, the host can start a model
 * ask for each installed harness it has not asked in this worktree this
 * launch, or retry the running harness's unanswered ask once its agent has
 * signed in. Only an ask that returns models makes the host tell every tab to
 * ask again. With none, an open tab keeps its last answer, so this does not
 * always clear a tab still saying developer mode is off.
 */
export function useAgentTabRefresh(
  clusterId: string | null,
  environmentKey: string | null,
  agentTab: string | null,
): void {
  useEffect(() => {
    if (clusterId === null || agentTab === null) return;
    let live = true;
    const unlisten: (() => void)[] = [];
    const ask = () => {
      if (!live) return;
      appCall(AGENT_TAB_APP, "agent-tab/harnesses", undefined, {
        clusterId,
        instanceId: agentTab,
      }).catch(() => undefined);
    };
    ask();
    void (async () => {
      const listeners = [
        onSettingsChanged(ask),
        onAgentTabEvent((payload) => {
          if (instanceOf(payload) === agentTab && movesTheSession(payload)) ask();
        }),
      ];
      for (const listening of listeners) {
        const stop = await listening;
        if (live) unlisten.push(stop);
        else stop();
      }
    })();
    return () => {
      live = false;
      unlisten.forEach((stop) => stop());
    };
  }, [clusterId, environmentKey, agentTab]);
}

function instanceOf(payload: unknown): unknown {
  return (payload as { instanceId?: unknown } | null)?.instanceId;
}

/** A new status or a reset: the two events after which the host knows more. */
function movesTheSession(payload: unknown): boolean {
  const type = (payload as { event?: { type?: unknown } } | null)?.event?.type;
  return type === "status" || type === "reset";
}
