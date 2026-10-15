import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  LoaderCircle,
  Plus,
  type LucideIcon,
} from "lucide-react";
import {
  NO_SESSION,
  type AgentCluster,
  type AgentSession,
  type AgentSessionState,
} from "../state/agentSessions";
import "./agentspage.css";

/** The page's words, in one place. */
const TEXT = {
  newSession: (cluster: string) => `New agent session in ${cluster}`,
  empty: "No agent sessions",
  untitled: "New session",
  current: "Current cluster",
  state: {
    none: "Not started",
    starting: "Starting",
    ready: "Ready",
    working: "Working",
    needsInput: "Needs you",
    stopped: "Stopped",
    failed: "Failed",
  } satisfies Record<AgentSessionState, string>,
  harness: { claude: "Claude", codex: "Codex", kaava: "Kaava" } as Record<string, string>,
};

const ICON: Record<AgentSessionState, LucideIcon> = {
  none: Circle,
  starting: LoaderCircle,
  ready: CircleCheck,
  working: LoaderCircle,
  needsInput: CircleAlert,
  stopped: CircleStop,
  failed: CircleX,
};

export interface AgentsPageProps {
  clusters: readonly AgentCluster[];
  sessions: ReadonlyMap<string, AgentSession>;
  activeClusterId: string | null;
  /** Bring a tab forward, in whichever cluster holds it. */
  onOpen: (instanceId: string) => void;
  /** Open a new agent tab in a cluster. */
  onNew: (clusterId: string) => void;
}

function Row({
  title,
  session,
  onOpen,
}: {
  title: string;
  session: AgentSession;
  onOpen: () => void;
}) {
  const Icon = ICON[session.state];
  const harness =
    session.harness === null ? null : (TEXT.harness[session.harness] ?? session.harness);
  const state = TEXT.state[session.state];
  return (
    <li>
      <button type="button" className="k-agents__row" data-state={session.state} onClick={onOpen}>
        <Icon className="k-agents__glyph" size={14} strokeWidth={2} aria-hidden />
        <span className="k-agents__text">
          <span className="k-agents__title" title={session.prompt ?? undefined}>
            {session.prompt ?? (title || TEXT.untitled)}
          </span>
          <span className="k-agents__meta">{harness ? `${harness} · ${state}` : state}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The Agents page: every cluster's agent sessions, live. A row brings its tab
 * forward, in its own cluster; a cluster's `+` opens a new agent tab there.
 * The shell draws it (`pages.rs`'s `app_id: None`), from `useAgentSessions`.
 */
export default function AgentsPage({
  clusters,
  sessions,
  activeClusterId,
  onOpen,
  onNew,
}: AgentsPageProps) {
  return (
    <div className="k-agents">
      {clusters.map((cluster) => (
        <section
          key={cluster.id}
          className="k-agents__cluster"
          aria-labelledby={`k-agents-${cluster.id}`}
          data-active={cluster.id === activeClusterId ? "" : undefined}
        >
          <header className="k-agents__head">
            <h3 id={`k-agents-${cluster.id}`} className="k-agents__name">
              {cluster.name}
            </h3>
            {cluster.id === activeClusterId && (
              <span className="k-agents__current">{TEXT.current}</span>
            )}
            <button
              type="button"
              className="k-agents__new"
              aria-label={TEXT.newSession(cluster.name)}
              title={TEXT.newSession(cluster.name)}
              onClick={() => onNew(cluster.id)}
            >
              <Plus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </header>
          {cluster.tabs.length === 0 ? (
            <p className="k-agents__empty">{TEXT.empty}</p>
          ) : (
            <ul className="k-agents__list">
              {cluster.tabs.map((tab) => (
                <Row
                  key={tab.id}
                  title={tab.title}
                  session={sessions.get(tab.id) ?? NO_SESSION}
                  onOpen={() => onOpen(tab.id)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
