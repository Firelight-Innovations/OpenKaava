import { MessageSquare, PanelBottom, PanelRight, Plus, Settings } from "lucide-react";

/** Where Upgrade goes until there is a plans page of our own to send people to. */
export const UPGRADE_URL = "https://veistra.com";

const TEXT = {
  upgrade: "Upgrade",
  newAgent: "New agent session",
  terminal: "Terminal",
  agents: "Agents",
  clusters: "Clusters (Ctrl+B)",
  settings: "Settings",
};

export interface TitleBarActionsProps {
  /** Open the website. Passed in so the bar never reaches for the opener plugin itself. */
  onUpgrade: () => void;
  /** Open a new agent tab in the active cluster. Absent while there is no cluster. */
  onNewAgent?: () => void;
  /** Whether the terminal band is showing. */
  terminalOpen: boolean;
  /** Show the terminal band, opening a terminal if none exists, or fold it away. */
  onToggleTerminal: () => void;
  /** Whether the Agents page is the one docked on the right. */
  agentsOpen: boolean;
  onToggleAgents: () => void;
  /** Whether the cluster list is showing at the window's right edge (Ctrl+B). */
  clustersOpen: boolean;
  onToggleClusters: () => void;
  onOpenSettings: () => void;
}

/**
 * The right-hand cluster of the title bar, in Cursor's order: Upgrade, then
 * new agent, terminal, agents window and settings, each an icon button.
 */
export default function TitleBarActions({
  onUpgrade,
  onNewAgent,
  terminalOpen,
  onToggleTerminal,
  agentsOpen,
  onToggleAgents,
  clustersOpen,
  onToggleClusters,
  onOpenSettings,
}: TitleBarActionsProps) {
  return (
    <>
      <button type="button" className="titlebar__upgrade" onClick={onUpgrade}>
        {TEXT.upgrade}
      </button>
      <button
        type="button"
        className="titlebar__icon"
        aria-label={TEXT.newAgent}
        title={TEXT.newAgent}
        disabled={onNewAgent === undefined}
        onClick={onNewAgent}
      >
        <Plus size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="titlebar__icon"
        aria-label={TEXT.terminal}
        title={TEXT.terminal}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <PanelBottom size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="titlebar__icon"
        aria-label={TEXT.agents}
        title={TEXT.agents}
        aria-pressed={agentsOpen}
        onClick={onToggleAgents}
      >
        <MessageSquare
          size={16}
          strokeWidth={2}
          fill={agentsOpen ? "currentColor" : "none"}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className="titlebar__icon"
        aria-label={TEXT.clusters}
        title={TEXT.clusters}
        aria-pressed={clustersOpen}
        onClick={onToggleClusters}
      >
        <PanelRight size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="titlebar__icon"
        aria-label={TEXT.settings}
        title={TEXT.settings}
        onClick={onOpenSettings}
      >
        <Settings size={16} strokeWidth={2} aria-hidden="true" />
      </button>
    </>
  );
}
