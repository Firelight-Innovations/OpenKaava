import { MessagePrimitive } from "@assistant-ui/react";
import type { TurnProps } from "./types";
import "./turns.css";

export function UserTurn({ children }: TurnProps) {
  return (
    <MessagePrimitive.Root className="at-turn at-turn--user">{children}</MessagePrimitive.Root>
  );
}
