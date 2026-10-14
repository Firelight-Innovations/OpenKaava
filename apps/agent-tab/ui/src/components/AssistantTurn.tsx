import { MessagePrimitive } from "@assistant-ui/react";
import { useSlots } from "./registry";
import type { TurnProps } from "./types";
import "./turns.css";

export function AssistantTurn({ children }: TurnProps) {
  const S = useSlots();
  return (
    <MessagePrimitive.Root className="at-turn at-turn--agent">
      {children}
      <S.TurnActions />
    </MessagePrimitive.Root>
  );
}
