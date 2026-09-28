/**
 * The environment bar: a 36px strip above the pane grid saying which
 * environment the open cluster is working in, and what you can do about it.
 *
 * `docs/design/KAAVA-UX-SPEC.md` §1.4. Two boards give this a real variant —
 * a local worktree (board 02) and a cloud session (board 03) — and this file
 * builds a third, undrawn one for `main`: a cluster with no worktree is
 * working directly in the project folder, which the written spec calls
 * read-only by definition. No board crops that state, so its colours are the
 * bar's own neutral tokens rather than anything lifted from a mock — flagged
 * here rather than guessed from the worktree variant's.
 *
 * Two things §1.4 draws that this component does not, both because nothing in
 * the shell's state can back them honestly yet — see `docs/KAAVA-UX-REWORK.md`'s
 * "never fake data" rule:
 *
 *   - **`from base@<hash>`**: no source in `contract.ts`/`bindings.ts` carries
 *     a worktree's merge base or the hash it forked from. `Environment.base`
 *     (`environment.ts`) is typed for the day one does; until then the segment
 *     is omitted rather than left blank or invented.
 *   - **the agent-state badge** ("claude working here"): the shell has no live
 *     "an agent is working right now" signal — `TerminalSession.agentFinished`
 *     means the opposite (done, not working), and `TerminalControl.busy` is a
 *     one-shot check called on close, not a continuous state. Omitted for the
 *     same reason `ClusterBar`'s activity dot is (see that file).
 *
 * Ahead/behind *is* real: it is `GitStatus.ahead`/`.behind`, the same
 * cluster-scoped read `StatusBar` already uses, passed in rather than
 * re-fetched here.
 *
 * The cloud variant's **streaming pill** ("streaming · 42 ms") is left out
 * for the same "no source for it" reason as the two bullets above — nothing
 * measures a session's own latency today — and is moot regardless while
 * `environmentOf` cannot return `"cloud"`.
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
  /**
   * Worktree/design only. Opens the Git page — the **rail** workstream's to
   * build — so this is `WindowRoot`'s no-op until that page exists, the same
   * way `TitleBarProps.onOpenProjectSwitcher` is. The button is real and
   * clickable regardless; it simply has nothing to open yet.
   */
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
          <span className="envbar__ahead">↑{ahead}</span> <span className="envbar__behind">↓{behind}</span>
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
