/**
 * The terminal panel: a band under the tool window, with its sessions listed
 * down the left and the emulator deck filling the rest.
 *
 * The list runs vertically because this band is wide and short, where
 * the old secondary panel's strip was tall and narrow. A horizontal strip here would
 * spend the band's scarce height on tabs rather than on output, and a column
 * holds a dozen sessions without scrolling where the strip started scrolling at
 * about four.
 *
 * The deck is a slot rather than something this file renders, matching the
 * arrangement the old secondary panel used: an unmounted emulator loses its
 * scrollback and whatever its running program had drawn, so the caller mounts
 * it once and never tears it down to switch sessions.
 *
 * Two things this region may not reach for itself under STANDARDS.md §1.2, and
 * so arrive as props instead: the drop zone that lets a terminal be dragged
 * back out of the layout, and the deck. See `zoneRef` below.
 */
import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode } from "react";
import {
  groupTerminalTabs,
  type DragHandleProps,
  type TerminalBusy,
  type TerminalSession,
  type TerminalTabGroup,
} from "../contract";
import { Close, Plus } from "../../ui/Icon";
import { snap } from "../motion";
import CloseConfirm from "./CloseConfirm";
import "./bottompanel.css";

export interface BottomPanelProps {
  /** This cluster's terminals, already excluding any dragged into the layout. */
  sessions: TerminalSession[];
  /** A session id or a shared group id. Never `"worktree"`; that tab is gone. */
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onNewTerminal: () => void;
  /**
   * Split the active session. Disabled with nothing to split rather than
   * hidden — a control that vanishes reads as one that never existed.
   */
  onSplitTerminal: () => void;
  /**
   * Asks; it does not close. `WindowRoot` decides whether the session is busy
   * enough to need confirming, through the same path the Terminal menu's Kill
   * item uses.
   */
  onRequestClose: (tab: TerminalTabGroup) => void;
  pendingClose: { id: string; title: string; busy: TerminalBusy } | null;
  onCancelClose: () => void;
  onConfirmClose: () => void;
  /** The whole deck. Undefined renders nothing, not a placeholder. */
  terminalView?: ReactNode;
  /**
   * The drag layer's drop-zone ref, registered on this band's outer box so a
   * terminal dragged into the layout can be dragged back.
   *
   * Handed in rather than taken from `useDropZone` here: the drag layer is
   * another region, and STANDARDS.md §1.2 has this one built against
   * `contract.ts` and props alone.
   */
  zoneRef?: (el: HTMLDivElement | null) => void;
  /**
   * Spread onto each entry to make it a drag source. This is the only way a
   * terminal reaches a pane in the layout, so it is not optional in spirit.
   */
  dragHandleFor?: (session: TerminalSession) => DragHandleProps | undefined;
  /** A drag would land here on release. Drawn, not decided, by this component. */
  dropActive?: boolean;
}

export default function BottomPanel({
  sessions,
  activeTabId,
  onSelectTab,
  onNewTerminal,
  onSplitTerminal,
  onRequestClose,
  pendingClose,
  onCancelClose,
  onConfirmClose,
  terminalView,
  zoneRef,
  dragHandleFor,
  dropActive = false,
}: BottomPanelProps) {
  const tabs = groupTerminalTabs(sessions);

  return (
    <div className="bottompanel" ref={zoneRef} data-drop-active={dropActive || undefined}>
      <div className="bottompanel__rail">
        <div className="bottompanel__railhead">
          <span className="bottompanel__railtitle">Terminals</span>

          {/* Split and Kill were on the title bar's Terminal menu and nowhere
              else, because the only surface naming a session was a 34px strip
              with no room for per-entry controls. This rail has the room. The
              menu items stay — an accelerator has to keep working — and both
              routes call these same handlers, so there is one implementation
              and two doors onto it. */}
          <button
            type="button"
            className="bottompanel__railbtn"
            onClick={onNewTerminal}
            aria-label="New terminal"
            title="New terminal"
          >
            <Plus size={12} />
          </button>
          <button
            type="button"
            className="bottompanel__railbtn"
            onClick={onSplitTerminal}
            disabled={tabs.length === 0}
            aria-label="Split terminal"
            title="Split terminal"
          >
            <SplitGlyph />
          </button>
        </div>

        {/* A native scrollbar, where the rest of the shell uses the overlay one.
            That component is another region's and cannot be imported here; the
            fix if this looks out of place is to move it somewhere shared, not
            to punch through the boundary. */}
        <div className="bottompanel__list">
          {tabs.map((tab) => (
            <SessionEntry
              key={tab.id}
              group={tab}
              active={tab.id === activeTabId}
              onSelect={onSelectTab}
              onRequestClose={onRequestClose}
              dragHandle={dragHandleFor?.(tab.sessions[0])}
            />
          ))}

          {/* Not a disabled-looking blank. A band with no sessions is the state
              the panel opens in the first time, and the one thing worth saying
              there is how to get one. */}
          {tabs.length === 0 && (
            <button type="button" className="bottompanel__empty" onClick={onNewTerminal}>
              No terminals yet — start one
            </button>
          )}
        </div>
      </div>

      <div className="bottompanel__body">{terminalView ?? null}</div>

      <AnimatePresence>
        {pendingClose && (
          <CloseConfirm
            title={pendingClose.title}
            busy={pendingClose.busy}
            onCancel={onCancelClose}
            onConfirm={onConfirmClose}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * One session, or one split group drawn as a single entry.
 *
 * A `div role="tab"` rather than a `<button>`, for the reason every other tab in
 * the shell gives: a button may not nest the close button this needs.
 */
function SessionEntry({
  group,
  active,
  onSelect,
  onRequestClose,
  dragHandle,
}: {
  group: TerminalTabGroup;
  active: boolean;
  onSelect: (id: string) => void;
  onRequestClose: (tab: TerminalTabGroup) => void;
  dragHandle?: DragHandleProps;
}) {
  const primary = group.sessions[0];
  // Either half of a split could be the agent that just finished, and there is
  // one dot to say so with.
  const finished = group.sessions.some((s) => s.agentFinished);

  const classes = ["bottompanel__entry"];
  if (active) classes.push("bottompanel__entry--active");

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={classes.join(" ")}
      title={primary.title}
      onClick={() => onSelect(group.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(group.id);
        }
      }}
      onPointerDown={dragHandle?.onPointerDown}
      style={dragHandle?.style}
    >
      {/* Down the leading edge rather than across the top: this list stacks
          vertically, so the edge it shares with its neighbours is a side, and a
          rule along the top would read as a divider between two entries rather
          than a mark on one. */}
      {active && (
        <motion.div className="bottompanel__rule" layoutId="bottompanel-rule" transition={snap} />
      )}

      <span className="bottompanel__entry-label">{primary.title}</span>
      {group.sessions.length > 1 && (
        <span className="bottompanel__entry-count">{group.sessions.length}</span>
      )}

      {/* One box, two mutually exclusive occupants, so the entry's width never
          changes on hover. */}
      <span className="bottompanel__entry-end">
        {finished && <span className="bottompanel__entry-dot" />}
        <button
          type="button"
          className="bottompanel__entry-close"
          aria-label={`Close ${primary.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onRequestClose(group);
          }}
          // Must never reach the entry's own pointerdown, which is the drag
          // handle: a click meant to close is not the start of a drag.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Close />
        </button>
      </span>
    </div>
  );
}

/**
 * Split, drawn here rather than added to `ui/Icon.tsx`.
 *
 * That file is the shell's shared set, and this is the only place that needs
 * this shape. It moves there the moment a second caller appears; until then a
 * shared icon with one user is a wider surface for no gain.
 */
function SplitGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect x="0.75" y="1.75" width="10.5" height="8.5" rx="1.25" stroke="currentColor" />
      <line x1="6" y1="1.75" x2="6" y2="10.25" stroke="currentColor" />
    </svg>
  );
}
