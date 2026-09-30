/**
 * The environment summary: which environment the open cluster is working in
 * (kind chip, branch, ahead/behind, path). It used to be its own 36px bar
 * above the pane grid (`docs/design/KAAVA-UX-SPEC.md` §1.4); it now sits in the
 * title bar after the menus so the panes get that height back. The title bar
 * owns the row and the collapse order (`titlebar.css`): path goes first, then
 * ahead/behind, then the chip's label. `Review & merge` is a separate control on
 * the bar's right — see `ReviewMergeButton`.
 */
// Left out for "never fake data" (`docs/KAAVA-UX-REWORK.md`): the spec's
// `from base@<hash>` segment (no merge-base source in `contract.ts`/
// `bindings.ts` yet — see `Environment.base`), the agent-state badge (no
// live "working now" signal — `TerminalSession.agentFinished` means the
// opposite, `TerminalControl.busy` is one-shot), and the cloud variant's
// streaming pill (no latency source, and moot while `environmentOf` cannot
// return `"cloud"`).
//
// Ahead/behind *is* real, though: `GitStatus.ahead`/`.behind`, the same
// cluster-scoped read `StatusBar` uses, passed in here rather than
// re-fetched.
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
  onPullIntoWorktree,
  onStopSession,
}: EnvironmentBarProps) {
  const Glyph = KIND_ICON[environment.kind];
  const label = ENVIRONMENT_BAR_LABEL[environment.kind];

  if (environment.kind === "main") {
    return (
      <div className="envbar envbar--main" data-tauri-drag-region>
        <span className="envbar__kind" data-tauri-drag-region>
          <Lock size={12} strokeWidth={1.5} className="envbar__kind-icon" />
          <span className="envbar__kind-label">{label}</span>
        </span>
        <span className="envbar__readonly" data-tauri-drag-region>
          Browse only · main is read-only
        </span>
      </div>
    );
  }

  const cloud = environment.kind === "cloud";

  return (
    <div
      className={cloud ? "envbar envbar--cloud" : "envbar envbar--worktree"}
      data-tauri-drag-region
    >
      <span className="envbar__kind" data-tauri-drag-region>
        <Glyph size={12} strokeWidth={1.5} className="envbar__kind-icon" />
        <span className="envbar__kind-label">{label}</span>
      </span>

      {environment.branch !== undefined && (
        <span className="envbar__branch" data-tauri-drag-region>
          {environment.branch}
        </span>
      )}

      {!cloud && ahead !== undefined && behind !== undefined && (
        <span
          className="envbar__ahead-behind"
          data-tauri-drag-region
          title={`${ahead} ahead, ${behind} behind`}
        >
          <span className="envbar__ahead">↑{ahead}</span>{" "}
          <span className="envbar__behind">↓{behind}</span>
        </span>
      )}

      {!cloud && environment.path !== undefined && (
        <span className="envbar__path" data-tauri-drag-region title={environment.path}>
          {environment.path}
        </span>
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
