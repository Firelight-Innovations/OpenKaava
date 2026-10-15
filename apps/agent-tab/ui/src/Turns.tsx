/**
 * The conversation, turn by turn, through assistant-ui's thread. Each part of
 * a message names its item (`thread.ts`), and is drawn by looking the item up
 * and handing it to `ItemView`, so every item still comes from its slot.
 *
 * The part components are defined once, here, and read the items from
 * context: components made inside a render would remount on every envelope.
 */
import { createContext, useContext, type ReactNode } from "react";
import { MessagePrimitive, ThreadPrimitive } from "@assistant-ui/react";
import type { Item } from "./protocol.generated";
import { ItemView, type ItemActions } from "./Items";
import { useSlots } from "./components/registry";

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

function ById({ id }: { id: string | undefined }) {
  const lookup = useContext(LookupContext);
  const item = id === undefined ? undefined : lookup?.byId.get(id);
  return item && lookup ? <ItemView item={item} actions={lookup.actions} /> : null;
}

/**
 * assistant-ui draws this in an empty agent turn, and after a turn's last
 * tool row, whether or not the turn is still running: it is left to us to
 * check. A turn waiting on an approval is open but not working.
 */
function Empty({ status }: { status: { type: string } }) {
  const S = useSlots();
  const waiting = useContext(LookupContext)?.waiting ?? false;
  return status.type === "running" && !waiting ? <S.Working /> : null;
}

const parts = {
  Text: ({ id }: { id?: string }) => <ById id={id} />,
  Reasoning: ({ id }: { id?: string }) => <ById id={id} />,
  Empty,
  tools: { Override: ({ toolCallId }: { toolCallId: string }) => <ById id={toolCallId} /> },
};

export function Turns() {
  const S = useSlots();
  return (
    <ThreadPrimitive.Messages>
      {({ message }) =>
        message.role === "user" ? (
          <S.UserTurn>
            <MessagePrimitive.Parts components={parts} />
          </S.UserTurn>
        ) : (
          <S.AssistantTurn>
            <MessagePrimitive.Parts components={parts} />
          </S.AssistantTurn>
        )
      }
    </ThreadPrimitive.Messages>
  );
}
