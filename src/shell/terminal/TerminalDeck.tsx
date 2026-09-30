import { forwardRef, useImperativeHandle, useRef } from "react";
import type { TerminalSession, TerminalTransport } from "../contract";
import XTermView, { type XTermHandle } from "./XTermView";
import TerminalSlot from "./TerminalSlot";
import "./terminal.css";

export interface TerminalDeckHandle {
  /**
   * Clear one pane's screen. Sends nothing to the pty — a full-screen TUI
   * reads its own terminal state from the emulator, not from what a shell
   * command happened to print, so `cls`/`clear` written into the stream
   * would do nothing to it (or worse, get typed into whatever prompt it's
   * showing). Calling xterm's own `clear()` is the only thing that's honest
   * about what "clear" means here.
   */
  clear: (id: string) => void;
}

/**
 * Every session's emulator, one tab visible — and, within that tab, one or
 * more panes.
 *
 * The same problem `ToolWindow`/`ToolMount` solve for tool iframes — keep
 * every instance mounted so it never loses state, show exactly one — solved
 * the same way here rather than a second way: one `XTermView` per session,
 * all mounted at once, hidden with `display: none` rather than unmounted or
 * `visibility: hidden`. `display: none` (not `visibility`) is deliberate —
 * it's what makes a hidden container measure 0×0, which is the signal
 * `XTermView`'s `ResizeObserver` relies on to skip fitting a terminal nobody
 * can see and to catch the moment it becomes visible again.
 */
function TerminalDeck(
  {
    sessions,
    activeId,
    focusedId,
    onFocusPane,
    transport,
    onTitle,
    fileDropTargetId = null,
  }: {
    /** Mounting and unmounting follows these appearing and disappearing —
     *  nothing else. */
    sessions: TerminalSession[];
    /** A tab id — a session id, or a shared group id — or "" when the
     *  worktree tab is the active one, in which case every terminal here is
     *  hidden and none of them is "the" active one. */
    activeId: string;
    /**
     * Which pane counts as "the" one for split/clear/kill, within the active
     * group. Meaningless outside a split (there is only ever one candidate),
     * so this is only read when the active tab actually has more than one
     * member.
     */
    focusedId: string | null;
    onFocusPane: (id: string) => void;
    transport: TerminalTransport;
    /**
     * A session's own program set its title. Optional, matching `terminalView`
     * on `SecondaryPanel` — a caller that has no use for reported titles
     * (there is none today) just omits it. Bound with each session's id below,
     * so `XTermView` itself never has to know which session it's reporting
     * for.
     */
    onTitle?: (id: string, title: string) => void;
    /**
     * Which session files are currently being dragged over, if any. Passed
     * straight through to the one emulator it names; the deck does nothing
     * else with it, and in particular does not decide it — a drag can be over
     * a terminal in a pane instead, which this component never sees. Optional
     * like `onTitle`, and for the same reason.
     */
    fileDropTargetId?: string | null;
  },
  ref: React.ForwardedRef<TerminalDeckHandle>,
) {
  const paneRefs = useRef(new Map<string, XTermHandle>());

  useImperativeHandle(
    ref,
    () => ({
      clear: (id) => paneRefs.current.get(id)?.clear(),
    }),
    [],
  );

  // The active tab's members, in `sessions` order. Length 1 for an ordinary
  // tab; length 2+ only when `activeId` names a group with more than one
  // session still in it.
  const activeSessions = sessions.filter(
    (s) => s.id === activeId || (s.groupId !== null && s.groupId === activeId),
  );
  const isSplit = activeSessions.length > 1;

  // Split panes are laid out without restructuring this DOM into a wrapper per
  // group. Every session keeps its own permanent, unmoving `.terminal__slot`
  // sibling — same as before splitting existed — and a pane that's part of the
  // *active* group only gets CSS custom properties (`--pane-index`,
  // `--pane-count`) telling it which horizontal slice to occupy; `terminal.css`
  // does the rest. Wrapping split members in a shared flex parent instead would
  // mean moving a mounted `XTermView` to a new position in the tree the moment a
  // split happens — indistinguishable, to React, from unmounting it, which would
  // lose the very scrollback and running-program state splitting is supposed to
  // preserve.
  return (
    <div className="terminal__deck">
      {sessions.map((session) => {
        const paneIndex = activeSessions.findIndex((s) => s.id === session.id);
        const isActive = paneIndex !== -1;
        const focused = isSplit && session.id === focusedId;

        return (
          <TerminalSlot
            key={session.id}
            sessionId={session.id}
            className={isSplit ? "terminal__slot terminal__slot--split" : "terminal__slot"}
            active={isActive}
            focused={focused}
            style={
              isSplit
                ? ({
                    "--pane-index": paneIndex,
                    "--pane-count": activeSessions.length,
                  } as React.CSSProperties)
                : undefined
            }
            // Clicking anywhere in a pane — not just its xterm textarea —
            // moves focus there, so the affordance responds to the same
            // press that's about to move keyboard focus into it, not a
            // frame later once the textarea itself reports it.
            onPointerDown={isSplit ? () => onFocusPane(session.id) : undefined}
          >
            <XTermView
              ref={(handle) => {
                if (handle) paneRefs.current.set(session.id, handle);
                else paneRefs.current.delete(session.id);
              }}
              id={session.id}
              transport={transport}
              onTitle={onTitle && ((title) => onTitle(session.id, title))}
              onFocus={isSplit ? () => onFocusPane(session.id) : undefined}
              fileDropActive={session.id === fileDropTargetId}
            />
          </TerminalSlot>
        );
      })}

      {isSplit &&
        activeSessions.slice(1).map((session, i) => (
          <div
            key={`divider-${session.id}`}
            className="terminal__divider"
            style={
              {
                "--pane-index": i + 1,
                "--pane-count": activeSessions.length,
              } as React.CSSProperties
            }
          />
        ))}
    </div>
  );
}

export default forwardRef(TerminalDeck);
