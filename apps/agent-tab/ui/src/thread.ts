/**
 * The transcript as assistant-ui sees it. Each user prompt is a user message,
 * and everything the agent does until the next prompt is one assistant
 * message, one part per item.
 *
 * Every part carries its item's id, and the tab draws a part by looking that
 * item up and handing it to `ItemView`. assistant-ui owns the thread's shape
 * (turns, scrolling, the action bar); the slots still draw every item.
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Item } from "./protocol.generated";

/** The tool name for every item that is not text or reasoning. */
export const ITEM_TOOL = "kaava.item";

/** One turn: a run of items that becomes one message. */
export interface Turn {
  readonly id: string;
  readonly items: readonly Item[];
  readonly message: ThreadMessageLike;
}

function part(item: Item): Exclude<ThreadMessageLike["content"], string>[number] {
  const kind = item.kind;
  switch (kind.kind) {
    case "userMessage":
      return { type: "text", id: item.id, text: kind.text };
    case "assistantText":
      return { type: "text", id: item.id, text: kind.text };
    case "reasoning":
      return { type: "reasoning", id: item.id, text: kind.text };
    default:
      // `result` is set so assistant-ui does not wait on a tool result: the
      // agent ran the tool, and the item already says how it went.
      return {
        type: "tool-call",
        toolCallId: item.id,
        toolName: ITEM_TOOL,
        args: {},
        result: null,
      };
  }
}

function turn(items: readonly Item[]): Turn {
  const first = items[0];
  const role = first.kind.kind === "userMessage" ? "user" : "assistant";
  return {
    id: first.id,
    items,
    message: { id: first.id, role, content: items.map(part) },
  };
}

function same(a: readonly Item[], b: readonly Item[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Groups items into turns. A turn whose items are the same objects as last
 * time is returned as the same object, so assistant-ui redraws only the turn
 * that changed.
 */
export function toTurns(items: readonly Item[], previous: readonly Turn[] = []): Turn[] {
  const runs: Item[][] = [];
  for (const item of items) {
    const user = item.kind.kind === "userMessage";
    const last = runs[runs.length - 1];
    if (user || !last || last[0].kind.kind === "userMessage") runs.push([item]);
    else last.push(item);
  }
  const before = new Map(previous.map((t) => [t.id, t]));
  return runs.map((run) => {
    const old = before.get(run[0].id);
    return old && same(old.items, run) ? old : turn(run);
  });
}
