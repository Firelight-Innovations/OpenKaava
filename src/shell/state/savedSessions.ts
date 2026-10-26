/**
 * The saved agent sessions of the cluster's project, for the Agents page's
 * "Previous sessions": the same list the agent tab's own history popover
 * shows. Asked with `agent-tab/history` scoped to the cluster, which needs no
 * agent tab, and again whenever Rust says one was saved or archived
 * (`agent-tab:history`). Nothing polls.
 */
import { useCallback, useEffect, useState } from "react";
import { appCall, onAgentTabHistory } from "../../bindings";
import { AGENT_TAB_APP } from "./agentTab";

/** Mirrors the agent tab's `rpc.SavedSession`. */
export interface SavedSession {
  id: string;
  title: string;
  /** When it was last saved, in milliseconds since the epoch. */
  updated: number;
  harness: string;
  archived: boolean;
}

/** Where the list comes from; tests swap it. */
export interface SavedSessionsSource {
  list: (clusterId: string) => Promise<SavedSession[]>;
  archive: (clusterId: string, id: string, archived: boolean) => Promise<unknown>;
  /** Hear that the saved sessions changed; resolves to the unlisten. */
  listen: (cb: () => void) => Promise<() => void>;
}

export const SAVED_SESSIONS: SavedSessionsSource = {
  list: (clusterId) =>
    appCall(AGENT_TAB_APP, "agent-tab/history", undefined, { clusterId }).then(
      (answer) => (answer as { sessions?: SavedSession[] } | null)?.sessions ?? [],
    ),
  archive: (clusterId, id, archived) =>
    appCall(AGENT_TAB_APP, "agent-tab/history-archive", { id, archived }, { clusterId }),
  listen: onAgentTabHistory,
};

/**
 * Open saved session `sessionId` in agent tab `instanceId`, as picking it in
 * that tab's own history popover does. Rust restores it into the tab and
 * sends the tab `agent-tab:restored`, so the tab attaches again and shows it.
 */
export const openSavedSession = (instanceId: string, sessionId: string) =>
  appCall(AGENT_TAB_APP, "agent-tab/history-open", { id: sessionId }, { instanceId });

/**
 * Names the open agent tab `instanceId`'s session, as `/rename` does in the
 * tab. A blank name takes the name back. The tab is told to read it again.
 */
export const renameAgentTab = (instanceId: string, name: string) =>
  appCall(
    AGENT_TAB_APP,
    "agent-tab/set-session-meta",
    { name: name.trim() === "" ? null : name, announce: true },
    { instanceId },
  );

export interface SavedSessions {
  /** Newest first, or `null` before the first answer. */
  sessions: SavedSession[] | null;
  /** The last ask failed: the cluster has no worktree, or the read did. */
  failed: boolean;
  archive: (id: string, archived: boolean) => void;
}

/** `clusterId`'s saved sessions, kept current while the caller is mounted. */
export function useSavedSessions(
  clusterId: string | null,
  source: SavedSessionsSource = SAVED_SESSIONS,
): SavedSessions {
  const [sessions, setSessions] = useState<SavedSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Bumped to ask again; the effect below drops an answer a later ask overtook.
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    void source
      .listen(() => setAsked((n) => n + 1))
      .then((unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      });
    return () => {
      live = false;
      stop?.();
    };
  }, [source]);

  useEffect(() => {
    if (clusterId === null) {
      setSessions([]);
      return;
    }
    let live = true;
    source.list(clusterId).then(
      (list) => {
        if (!live) return;
        setFailed(false);
        setSessions([...list].sort((a, b) => b.updated - a.updated));
      },
      () => {
        if (!live) return;
        setFailed(true);
        setSessions([]);
      },
    );
    return () => {
      live = false;
    };
  }, [clusterId, source, asked]);

  const archive = useCallback(
    (id: string, archived: boolean) => {
      if (clusterId === null) return;
      source.archive(clusterId, id, archived).then(
        () => setAsked((n) => n + 1),
        () => setFailed(true),
      );
    },
    [clusterId, source],
  );

  return { sessions, failed, archive };
}
