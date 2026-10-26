/**
 * What each agent tab's session is doing, for its pane tab's icon: filled when
 * the agent is done, fading in and out while it works. `WindowRoot` already
 * follows every session for the Agents page (`useAgentSessions`) and publishes
 * the states here, so the tab strip does not open a second subscription.
 */
import type { AgentSessionState } from "./state/agentSessions";

let states: ReadonlyMap<string, AgentSessionState> = new Map();
let version = 0;
const listeners = new Set<() => void>();

/** Replace every tab's state; listeners hear only when something changed. */
export function publishAgentTabStates(next: ReadonlyMap<string, AgentSessionState>): void {
  if (next.size === states.size && [...next].every(([id, s]) => states.get(id) === s)) return;
  states = next;
  version++;
  listeners.forEach((listener) => listener());
}

export function agentTabState(instanceId: string): AgentSessionState | undefined {
  return states.get(instanceId);
}

export function subscribeAgentTabStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentTabStatesVersion(): number {
  return version;
}
