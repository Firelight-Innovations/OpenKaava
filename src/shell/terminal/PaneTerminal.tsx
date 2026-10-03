import type { TerminalTransport } from "../contract";
import XTermView from "./XTermView";
import TerminalSlot from "./TerminalSlot";

/**
 * A terminal that lives in a tool-window pane.
 *
 * It is drawn through the same `TerminalSlot` as the band's sessions, so the
 * Context strip and its notice come with it rather than being wired a second
 * time. A terminal in a pane takes a file drop exactly as one in the band does;
 * nothing about the gesture depends on where the emulator is drawn.
 */
export default function PaneTerminal({
  id,
  transport,
  onTitle,
  fileDropActive,
}: {
  id: string;
  transport: TerminalTransport;
  onTitle: (title: string) => void;
  fileDropActive: boolean;
}) {
  return (
    <TerminalSlot
      sessionId={id}
      className="terminal__slot terminal__slot--pane"
      active
      focused={false}
    >
      <XTermView id={id} transport={transport} onTitle={onTitle} fileDropActive={fileDropActive} />
    </TerminalSlot>
  );
}
