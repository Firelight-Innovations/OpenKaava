/**
 * The notice above the panes while the active cluster is on the read-only primary checkout.
 * It says so in plain words and offers the one way forward: a worktree cluster. With no
 * repository (or no commit) there is nothing to branch from, so it offers to create one.
 * Reading and browsing are untouched; this only explains why writes are refused.
 */
import { useCallback, useEffect, useState } from "react";
import { gitDefaultBranch, gitRepoState, type RepoState } from "../../bindings";
import InitGitButton from "./InitGitButton";
import { repoPrompt } from "./repoPrompt";
import "./readOnlyBanner.css";

export interface ReadOnlyBannerProps {
  projectPath: string;
  /** Starts the existing "New worktree cluster…" flow (an in-app dialog). */
  onNewWorktreeCluster: () => void;
}

export default function ReadOnlyBanner({ projectPath, onNewWorktreeCluster }: ReadOnlyBannerProps) {
  const [state, setState] = useState<RepoState | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void gitRepoState(projectPath)
      .then((s) => live && setState(s))
      .catch(() => live && setState(null));
    void gitDefaultBranch(projectPath)
      .then((b) => live && setBranch(b))
      .catch(() => live && setBranch(null));
    return () => {
      live = false;
    };
  }, [projectPath, nonce]);

  const needsRepo = repoPrompt(state) !== null;
  const name = branch || "main";

  return (
    <div className="ro-banner" role="status" data-testid="read-only-banner">
      <span className="ro-banner__text">
        {needsRepo ? (
          <InitGitButton
            projectPath={projectPath}
            state={state}
            onInitialised={refresh}
            className="ro-banner__button"
            errorClassName="ro-banner__error"
          />
        ) : (
          <>
            <strong>{name} is read-only.</strong> You can read and browse, but to make changes you
            need a worktree cluster.
          </>
        )}
      </span>
      {!needsRepo && (
        <button type="button" className="ro-banner__button" onClick={onNewWorktreeCluster}>
          New worktree cluster…
        </button>
      )}
    </div>
  );
}
