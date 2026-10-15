/**
 * A run of tool calls read as one line, the way a coding agent's desktop app
 * folds them: "Ran 2 commands, read a file". Verbs come in the order the agent
 * first used them.
 */
import type { Item } from "./protocol.generated";
import { strings } from "./strings";

type Verb = keyof typeof strings.actions.verb;

/** ACP's tool kinds, by the verb that says what they did. */
const VERB: Record<string, Verb> = {
  execute: "execute",
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  fetch: "fetch",
};

export interface ActionSummary {
  summary: string;
  /** Some call has not finished yet. */
  running: boolean;
  /** How many calls failed. */
  failed: number;
}

/** The summary of a run of tool-call items. Items of any other kind are skipped. */
export function summarize(items: readonly Item[]): ActionSummary {
  const tally = new Map<Verb, number>();
  let running = false;
  let failed = 0;
  for (const item of items) {
    const kind = item.kind;
    if (kind.kind !== "toolCall") continue;
    const verb = VERB[kind.toolKind] ?? "other";
    tally.set(verb, (tally.get(verb) ?? 0) + 1);
    if (kind.status === "pending" || kind.status === "inProgress") running = true;
    if (kind.status === "failed") failed += 1;
  }
  const words = [...tally].map(([verb, n]) => strings.actions.verb[verb](n));
  const line = words.join(strings.actions.join);
  return { summary: line.charAt(0).toUpperCase() + line.slice(1), running, failed };
}
