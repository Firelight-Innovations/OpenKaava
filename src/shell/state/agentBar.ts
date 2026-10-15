/**
 * The agent bar's verbs: whether this cluster can run an agent, and sending a
 * prompt to the cluster's agent tab (handoff §4).
 *
 * The session itself lives in `src-tauri/src/apps/agent_tab.rs` and is keyed by
 * the agent tab's instance id, so sending means "find or open that tab, then
 * call `agent-tab/send` as it". The tab redraws from its own events.
 */
import { useEffect, useState } from "react";
import {
  activateInstance,
  appCall,
  onSettingsChanged,
  openInstance,
  type SplitDir,
} from "../../bindings";
import { paneLeaves, type PaneNode } from "../contract";

/** Mirrors `apps::agent_tab::ID`. */
export const AGENT_TAB_APP = "agent-tab";

/** Mirrors `apps::agent_tab::REFUSED`. */
const REFUSED = -32010;

/** Mirrors `apps::READ_ONLY`: the shell's refusal of a write on a main checkout. */
const READ_ONLY = -32003;

/** What `agent-tab/harnesses` says about one cluster. */
export interface AgentBarStatus {
  /** Why this cluster cannot run an agent, as a refusal code; `null` if it can. */
  blocked: string | null;
  /** What Claude still needs before it can run, as a hint key; `null` if nothing. */
  hint: string | null;
}

/**
 * Whether the bar is drawn. Not while the answer is unknown, and not while
 * developer mode is off: the bar is the feature's front door, and it stays
 * shut until then. A main checkout still shows it, disabled, with the reason.
 */
export function agentBarShown(status: AgentBarStatus | null): status is AgentBarStatus {
  return status !== null && status.blocked !== "developerMode";
}

interface HarnessesAnswer {
  harnesses: { harness: string; hint: string | null }[];
  blocked: string | null;
}

/**
 * Asks once per cluster or environment change, and again whenever a setting
 * changes, since developer mode decides whether the bar shows at all. `null`
 * until the first answer, and after a failed one.
 */
export function useAgentBarStatus(
  clusterId: string | null,
  environmentKey: string | null,
): AgentBarStatus | null {
  const [status, setStatus] = useState<AgentBarStatus | null>(null);

  useEffect(() => {
    if (clusterId === null) {
      setStatus(null);
      return;
    }
    let live = true;
    let unlisten: (() => void) | undefined;
    const load = () =>
      appCall(AGENT_TAB_APP, "agent-tab/harnesses", undefined, { clusterId }).then(
        (answer) => live && setStatus(statusOf(answer as HarnessesAnswer)),
        () => live && setStatus(null),
      );
    void load();
    void (async () => {
      const stop = await onSettingsChanged(() => void load());
      if (!live) return stop();
      unlisten = stop;
    })();
    return () => {
      live = false;
      unlisten?.();
    };
  }, [clusterId, environmentKey]);

  return status;
}

function statusOf(answer: HarnessesAnswer): AgentBarStatus {
  return { blocked: answer.blocked, hint: answer.harnesses[0]?.hint ?? null };
}

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

/** Where a send lands when the cluster has no agent tab yet. */
export interface SendTarget {
  label: string;
  tree: PaneNode;
  instances: ReadonlyMap<string, { appId: string }>;
  paneId: string | null;
  dir?: SplitDir;
}

/** A send that did not land. `message` is the refusal code, or `"failed"`. */
export class AgentSendError extends Error {
  // Declared here because the ES2020 lib's `Error` has no `cause`.
  readonly cause: unknown;

  constructor(code: string, options: { cause: unknown }) {
    super(code);
    this.name = "AgentSendError";
    this.cause = options.cause;
  }
}

/**
 * Bring the cluster's agent tab forward, or open one, then send `text` as it,
 * to whichever harness the tab runs. `harness`, picked in the bar, is chosen
 * for the tab first. Rejects with an `AgentSendError` naming the refusal code
 * from `agent_tab.rs`.
 */
export async function sendToAgent(
  target: SendTarget,
  text: string,
  harness: string | null = null,
): Promise<void> {
  const existing = agentTabIn(target.tree, target.instances);
  try {
    const instanceId =
      existing ??
      (await openInstance(target.label, AGENT_TAB_APP, target.paneId ?? undefined, target.dir));
    if (existing !== null) await activateInstance(existing);
    if (harness !== null) {
      await appCall(AGENT_TAB_APP, "agent-tab/choose", { harness }, { instanceId });
    }
    await appCall(AGENT_TAB_APP, "agent-tab/send", { text }, { instanceId });
  } catch (err) {
    throw new AgentSendError(refusalCode(err), { cause: err });
  }
}

/**
 * Choose the harness of the agent tab `instanceId`. Rejects with an
 * `AgentSendError` naming the refusal code: `running` while its agent runs
 * another.
 */
export async function chooseHarness(instanceId: string, harness: string): Promise<void> {
  try {
    await appCall(AGENT_TAB_APP, "agent-tab/choose", { harness }, { instanceId });
  } catch (err) {
    throw new AgentSendError(refusalCode(err), { cause: err });
  }
}

/** A rejection's refusal code, or `"failed"` for anything that is not one. */
export function refusalCode(err: unknown): string {
  const rpc = err as { code?: unknown; data?: { code?: unknown } } | null;
  if (rpc?.code === READ_ONLY) return "mainCheckout";
  if (rpc?.code === REFUSED && typeof rpc.data?.code === "string") return rpc.data.code;
  return "failed";
}
