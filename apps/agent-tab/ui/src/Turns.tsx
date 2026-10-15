/**
 * The conversation, turn by turn, through assistant-ui's thread. Each part of
 * a message names its item (`thread.ts`), and is drawn by looking the item up
 * and handing it to `ItemView`, so every item still comes from its slot.
 *
 * The part components are defined once, here, and read the items from
 * context: components made inside a render would remount on every envelope.
 */
import { createContext, useContext, type ReactNode } from "react";
import {
  MessagePrimitive,
  ThreadPrimitive,
  type PartState,
  type ThreadMessage,
} from "@assistant-ui/react";
import type { Item } from "./protocol.generated";
import { ItemView, type ItemActions } from "./Items";
import { useSlots } from "./components/registry";
import { summarize } from "./actions";
import { strings } from "./strings";
import { ACTION_TOOL } from "./thread";

interface Lookup {
  byId: ReadonlyMap<string, Item>;
  actions: ItemActions;
  /** The agent is waiting on the user, not working, though the turn is open. */
  waiting: boolean;
}

const LookupContext = createContext<Lookup | null>(null);

export function TurnsProvider({ value, children }: { value: Lookup; children: ReactNode }) {
  return <LookupContext.Provider value={value}>{children}</LookupContext.Provider>;
}

function ById({ id, live }: { id: string | undefined; live?: boolean }) {
  const lookup = useContext(LookupContext);
  const item = id === undefined ? undefined : lookup?.byId.get(id);
  return item && lookup ? <ItemView item={item} actions={lookup.actions} live={live} /> : null;
}

/** A prompt has only text. */
const userParts = {
  Text: ({ id }: { id?: string }) => <ById id={id} />,
};

const ACTIONS = "group-actions";

/**
 * Adjacent tool calls coalesce into one group. Every other item is a
 * `tool-call` part too (`thread.ts`), under another tool name, so an approval
 * or a plan breaks a run rather than hiding inside it. Module level, so the
 * grouping is not redone on every draw.
 */
function groupBy(part: PartState): readonly (typeof ACTIONS)[] | null {
  return part.type === "tool-call" && part.toolName === ACTION_TOOL ? [ACTIONS] : null;
}

/**
 * A run of tool calls: one call alone stays a plain row, two or more fold into
 * a group. Both go through `ActionGroup`, so the rows are not remounted when
 * the second call arrives.
 */
function Actions({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const S = useSlots();
  const lookup = useContext(LookupContext);
  const items = ids.flatMap((id) => {
    const item = lookup?.byId.get(id);
    return item ? [item] : [];
  });
  const { summary, running, failed } = summarize(items);
  return (
    <S.ActionGroup
      grouped={items.length > 1}
      summary={summary}
      running={running}
      failed={failed > 0 ? strings.actions.failed(failed) : null}
    >
      {children}
    </S.ActionGroup>
  );
}

/**
 * An agent turn's parts. assistant-ui marks the part still streaming in a
 * running turn as running, and adds an `indicator` while the turn runs and
 * has not ended on text: that is where `Working` goes.
 */
function AgentParts({ message }: { message: ThreadMessage }) {
  const S = useSlots();
  // An approval holds the turn open, but the agent is waiting, not working.
  const waiting = useContext(LookupContext)?.waiting ?? false;
  return (
    <MessagePrimitive.GroupedParts groupBy={groupBy}>
      {({ part, children }) => {
        switch (part.type) {
          case ACTIONS:
            return (
              <Actions ids={part.indices.map((i) => toolCallIdAt(message, i))}>{children}</Actions>
            );
          case "text":
            return <ById id={part.id} />;
          case "reasoning":
            return <ById id={part.id} live={part.status.type === "running"} />;
          case "tool-call":
            return <ById id={part.toolCallId} />;
          case "indicator":
            return waiting ? <></> : <S.Working />;
          default:
            // An empty fragment, not `null`: `null` would ask for a registered tool UI.
            return <></>;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

function toolCallIdAt(message: ThreadMessage, index: number): string {
  const part = message.content[index];
  return part?.type === "tool-call" ? part.toolCallId : "";
}

export function Turns() {
  const S = useSlots();
  return (
    <ThreadPrimitive.Messages>
      {({ message }) =>
        message.role === "user" ? (
          <S.UserTurn>
            <MessagePrimitive.Parts components={userParts} />
          </S.UserTurn>
        ) : (
          <S.AssistantTurn>
            <AgentParts message={message} />
          </S.AssistantTurn>
        )
      }
    </ThreadPrimitive.Messages>
  );
}
