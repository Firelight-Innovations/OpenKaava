/**
 * The right-click menu on an agent button, for whichever surface draws one.
 *
 * `useAgentMenu(actions)` hands back `open(subject)`, which a button calls from
 * its `onContextMenu`, and `menu`, the element to render once beside the buttons.
 * The menu is the one `agentMenuItems` builds, on `ContextMenuSurface`.
 */
import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import ContextMenuSurface, { type OpenContextMenu } from "./ContextMenuSurface";
import { agentMenuItems, type AgentMenuActions, type AgentMenuSubject } from "./agentMenuItems";

export interface AgentMenu {
  /** A button's `onContextMenu`: claims the click and opens the menu at it. */
  open: (
    subject: AgentMenuSubject,
    /** Actions only the caller knows, laid over the hook's own. */
    more?: AgentMenuActions,
  ) => (e: MouseEvent) => void;
  menu: ReactNode;
}

export function useAgentMenu(actions: AgentMenuActions | undefined): AgentMenu {
  const [opened, setOpened] = useState<OpenContextMenu | null>(null);
  const close = useCallback(() => setOpened(null), []);
  const open = useCallback(
    (subject: AgentMenuSubject, more?: AgentMenuActions) => (e: MouseEvent) => {
      // Claims the right-click, which is what tells `ContextMenuHost` to stand
      // down rather than draw its edit menu over this one.
      e.preventDefault();
      setOpened({
        at: { x: e.clientX, y: e.clientY },
        label: subject.kind === "open" ? "Agent actions" : "Saved session actions",
        items: agentMenuItems(subject, { ...actions, ...more }),
      });
    },
    [actions],
  );
  return { open, menu: <ContextMenuSurface opened={opened} onClose={close} /> };
}
