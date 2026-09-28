import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { GitStatus, UpdateNotice } from "../contract";
import type { Environment } from "../environment";
import { Sliders } from "../../ui/Icon";
import SettingsPopover from "./SettingsPopover";
import "./statusbar.css";

export interface StatusBarProps {
  /**
   * A newer OpenKaava, or `null` for nothing worth a pixel — which is what this is
   * almost always. `updateNotice` in `contract.ts` decides which; this
   * component only draws what it is given.
   */
  update: UpdateNotice | null;
  /** The active cluster's project, `null` while none is open — `§1.9`'s left
   *  cluster starts here. */
  project: string | null;
  /** The active cluster's environment, on the same `null`-while-no-cluster
   *  terms as `project` — drives the branch/environment segment and the
   *  trailing "main is read-only" label. See `environment.ts`. */
  environment: Environment | null;
  /**
   * One status, read for the ahead/behind upgrade to the branch segment and
   * for the diff-stat readout beside it — the same handle the source-control
   * view reads, cluster-scoped (see `useGitStatus` in `WindowRoot.tsx`).
   * `null` while the fetch has not landed yet or the environment has no
   * repository to read; the branch segment still draws from `environment`
   * alone in that case, just without the arrows.
   */
  git: GitStatus | null;
  githubOk: boolean;
}

/**
 * Left cluster, then right cluster, per §1.9: project name, branch/
 * environment and the diff-stat readout on the left; the update notice,
 * GitHub status, "main is read-only" and settings on the right. The bar's own
 * height is `.frame__statusbar`'s — this component only lays out its
 * contents and never touches that box.
 *
 * Settings is the shell's only entry point for it: there is no left rail,
 * and settings moved here when the rail was removed. Kept rightmost, past
 * the spec's own right-cluster chips, since it predates this rework and the
 * spec has no board that draws it.
 */
export default function StatusBar({ project, environment, git, githubOk, update }: StatusBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsWrapRef = useRef<HTMLDivElement>(null);

  // Dismiss like every other popover in the shell: a click outside, or Escape.
  useEffect(() => {
    if (!settingsOpen) return;

    const onPointerDown = (e: PointerEvent) => {
      if (!settingsWrapRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen]);

  return (
    <div className="statusbar">
      {environment !== null && (
        <>
          {project !== null && <span className="statusbar__project">{project}</span>}
          <span className="statusbar__branch">{branchSegment(environment, git)}</span>
          {git !== null && filesTouched(git) > 0 && <DiffStat status={git} />}
        </>
      )}

      <div className="statusbar__spacer" />

      {update !== null && <UpdateNoticeRow notice={update} />}

      <div className="statusbar__github">
        {/* The handoff only draws GitHub healthy (--ok). --err is this
            component's own extrapolation for `githubOk === false` — the
            spec has no failure-state crop for this dot to check against. */}
        <span
          className="statusbar__dot"
          style={{ background: githubOk ? "var(--ok)" : "var(--err)" }}
        />
        <span className="statusbar__label">GitHub</span>
      </div>

      {environment?.kind === "main" && (
        <span className="statusbar__readonly">main is read-only</span>
      )}

      <div className="statusbar__settings-wrap" ref={settingsWrapRef}>
        <button
          type="button"
          className="statusbar__settings"
          aria-expanded={settingsOpen}
          aria-label="Settings"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Sliders size={14} knobFill="var(--surface)" />
        </button>
        <AnimatePresence>
          {settingsOpen && <SettingsPopover onPicked={() => setSettingsOpen(false)} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * The update notice: a dot, a label, and a click when there is one.
 *
 * A `<button>` only when it can act, a `<span>` otherwise. The alternative — a
 * button that is `disabled` for the four states that cannot be pressed — would
 * put four inert buttons in a bar that has one real one, and a status readout
 * that looks pressable is the same lie a live-but-dead menu item tells.
 *
 * **Deliberately not a modal, a toast or a badge with a count.** The handoff
 * has no crop for any of those, and an update is the least urgent thing a
 * developer tool can have to say: it waits in the bar until somebody is
 * between tasks and looks down.
 */
function UpdateNoticeRow({ notice }: { notice: UpdateNotice }) {
  const dot = TONE_TOKEN[notice.tone];

  const body = (
    <>
      <span className="statusbar__dot" style={{ background: dot }} />
      <span className="statusbar__update-label">{notice.label}</span>
    </>
  );

  if (notice.onSelect === undefined) {
    return (
      <span className="statusbar__update" title={notice.detail}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="statusbar__update"
      title={notice.detail}
      onClick={notice.onSelect}
    >
      {body}
    </button>
  );
}

/** The dot's colour per tone. `--accent` is the user's, from Appearance. */
const TONE_TOKEN: Record<UpdateNotice["tone"], string> = {
  offer: "var(--accent)",
  status: "var(--text-dim-2)",
  error: "var(--err)",
};

/**
 * `main · ↑1 ↓0` — the spec's exact separator (a middle dot, not a pipe) and
 * arrows, confirmed verbatim against the handoff crop. The arrows are not
 * separately coloured there, so this stays one plain-text run rather than
 * wrapping them in their own span.
 *
 * The handoff doesn't draw the no-upstream case. `ahead`/`behind` have no way
 * to say "no upstream" distinctly from "even with it" (see the doc comment on
 * `Worktree` in contract.ts) — this treats zero-and-zero as no upstream and
 * prints the bare branch name, on the read that a branch evenly caught up
 * with its remote is the less useful thing to call out in a status bar.
 */
function branchText(status: { branch: string; ahead: number; behind: number }): string {
  if (status.ahead === 0 && status.behind === 0) return status.branch;
  return `${status.branch} · ↑${status.ahead} ↓${status.behind}`;
}

/**
 * The branch/environment segment's text: `main`, a bare branch name, or the
 * ahead/behind form above once `git` has landed for it.
 *
 * `main` short-circuits before touching `git` — a read-only checkout has no
 * upstream to be ahead or behind of, and the trailing "main is read-only"
 * chip already says the rest. Every other kind reads its name from
 * `environment.branch`, falling back to the environment's own kind label
 * only for the odd case a worktree or cloud session reports no branch yet;
 * `git` is assumed scoped to the same cluster (`useGitStatus` in
 * `WindowRoot.tsx`), so its ahead/behind numbers are trusted without
 * re-checking its own `branch` field against this one.
 */
function branchSegment(environment: Environment, git: GitStatus | null): string {
  if (environment.kind === "main") return "main";
  const name = environment.branch ?? environment.kind;
  if (git === null) return name;
  return branchText({ branch: name, ahead: git.ahead, behind: git.behind });
}

/**
 * How many distinct files this status touches, for the diff-stat readout's
 * `· M files`.
 *
 * Not `staged.length + unstaged.length`: a file that is staged and then
 * edited again appears once in each list (see the doc comment on
 * `GitFileChange` in `contract.ts`), and counting it twice would make this
 * number disagree with what `git status` itself would call one changed file.
 * The de-dupe is by `path` — the field every `GitFileChange` command takes
 * back as an argument, and so the one guaranteed to identify "the same file"
 * across both lists.
 */
function filesTouched(status: GitStatus): number {
  return new Set([...status.staged, ...status.unstaged].map((f) => f.path)).size;
}

/**
 * `+142 -63 · 9 files` — additions and deletions in the same green/red the
 * spec's token table already assigns an added/deleted file (`--ok`/`--err`
 * in tokens.css), the file count left in the bar's ordinary dim text rather
 * than a third colour. Coloured inline, the same way the GitHub
 * dots above set their own `background` — this is the one other place in the
 * bar a value picks its own colour instead of taking the row's.
 *
 * Only ever mounted by the caller once `filesTouched(status) > 0` — a status
 * bar is not the place to spend width saying "no changes".
 */
function DiffStat({ status }: { status: GitStatus }) {
  const files = filesTouched(status);
  return (
    <span className="statusbar__diffstat">
      <span style={{ color: "var(--ok)" }}>+{status.insertions}</span>{" "}
      <span style={{ color: "var(--err)" }}>-{status.deletions}</span>
      <span className="statusbar__diffstat-files">
        {" "}
        · {files} {files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}
