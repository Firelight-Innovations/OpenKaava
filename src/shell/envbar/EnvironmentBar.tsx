/**
 * The environment bar: a 36px strip above the pane grid saying which
 * environment the open cluster is working in, and what you can do about it.
 *
 * `docs/design/KAAVA-UX-SPEC.md` §1.4. Boards 02 (worktree) and 03 (cloud)
 * give this a real variant; this file adds an undrawn third for `main` — a
 * cluster with no worktree works directly in the project folder, which the
 * spec calls read-only, so it gets the bar's own neutral tokens rather than
 * colours guessed from a mock.
 */

import { Cloud, GitBranch, Lock } from "lucide-react";
import type { Environment, EnvironmentKind } from "../environment";
import { ENVIRONMENT_BAR_LABEL } from "../environment";
import "./envbar.css";

const KIND_ICON: Record<EnvironmentKind, typeof GitBranch> = {
  worktree: GitBranch,
  design: GitBranch,
  cloud: Cloud,
  main: Lock,
};

export interface EnvironmentBarProps {
  environment: Environment;
  /** Cluster-scoped `GitStatus.ahead`/`.behind` — omitted (not `0`) while
   *  nothing has measured it yet, which draws neither count rather than
   *  claiming the worktree is caught up. */
  ahead?: number;
  behind?: number;
  /** Worktree/design only. Opens the rail's Git page (`WindowRoot`'s
   *  `onSelectPage("git")`). */
  onReviewAndMerge?: () => void;
  /**
   * Cloud only, and both still no-ops: nothing in `Cluster` names a cloud
   * session today (see `environment.ts`'s header on why `environmentOf`
   * never returns `"cloud"`), so this bar's cloud variant cannot currently
   * render from real data — kept fully built, per that file's reasoning,
   * for the day a cloud cluster exists. `undefined` disables the button
   * honestly rather than wiring it to nothing that pretends to work.
   */
  onPullIntoWorktree?: () => void;
  onStopSession?: () => void;
}

/**
 * Three things §1.4 draws that this component does not, all because nothing
 * in the shell's state can back them honestly yet (`docs/KAAVA-UX-REWORK.md`'s
 * "never fake data" rule): `from base@<hash>` (no source carries a worktree's
 * merge base yet — see `Environment.base` in `environment.ts`), the
 * agent-state badge ("claude working here" — the shell has no continuous
 * "working right now" signal, only `TerminalSession.agentFinished`, which
 * means the opposite, and one-shot `TerminalControl.busy`; same reason
 * `ClusterBar`'s activity dot is omitted), and the cloud variant's streaming
 * pill (nothing measures a session's latency, and it is moot while
 * `environmentOf` cannot return `"cloud"` anyway). Ahead/behind *is* real —
 * `GitStatus.ahead`/`.behind`, the same read `StatusBar` already uses.
 */
export default function EnvironmentBar({
  environment,
  ahead,
  behind,
  onReviewAndMerge,
  onPullIntoWorktree,
  onStopSession,
}: EnvironmentBarProps) {
  const Glyph = KIND_ICON[environment.kind];
  const label = ENVIRONMENT_BAR_LABEL[environment.kind];

  if (environment.kind === "main") {
    return (
      <div className="envbar envbar--main">
        <span className="envbar__kind">
          <Lock size={12} strokeWidth={1.5} className="envbar__kind-icon" />
          {label}
        </span>
        <span className="envbar__readonly">Browse only · main is read-only</span>
      </div>
    );
  }

  const cloud = environment.kind === "cloud";

  return (
    <div className={cloud ? "envbar envbar--cloud" : "envbar envbar--worktree"}>
      <span className="envbar__kind">
        <Glyph size={12} strokeWidth={1.5} className="envbar__kind-icon" />
        {label}
      </span>

      {environment.branch !== undefined && (
        <span className="envbar__branch">{environment.branch}</span>
      )}

      {!cloud && ahead !== undefined && behind !== undefined && (
        <span className="envbar__ahead-behind">
          <span className="envbar__ahead">↑{ahead}</span>{" "}
          <span className="envbar__behind">↓{behind}</span>
        </span>
      )}

      {!cloud && environment.path !== undefined && (
        <span className="envbar__path" title={environment.path}>
          {environment.path}
        </span>
      )}

      <span className="envbar__spacer" />

      {!cloud && (
        <button type="button" className="envbar__action" onClick={onReviewAndMerge}>
          Review &amp; merge
        </button>
      )}

      {cloud && (
        <>
          <button
            type="button"
            className="envbar__action envbar__action--pull"
            disabled={onPullIntoWorktree === undefined}
            onClick={onPullIntoWorktree}
          >
            Pull into local worktree
          </button>
          <button
            type="button"
            className="envbar__action envbar__action--stop"
            disabled={onStopSession === undefined}
            onClick={onStopSession}
          >
            Stop session
          </button>
        </>
      )}
    </div>
  );
}
