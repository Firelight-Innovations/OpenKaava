/**
 * The tree's git decoration: what changed, reshaped for `TreeRow` and for the
 * directories that hold a change without showing it.
 *
 * What "like VS Code" turned out to mean is four rules, and `decorate` below is
 * all four of them in one place.
 *
 * One rule that reads as missing and is not: a deleted file is not struck
 * through, because it has no row. This tree is listed from disk, and a file
 * git reports as deleted is gone from disk — staged or not. Its parent folders
 * still tint through rule 2, which is the only place a deletion can show here.
 * The source control panel is where the file itself appears.
 */
import { invoke, subscribe } from "@veistra/bridge";
import { useEffect, useMemo, useState } from "react";
import { baseName } from "../rpc";
import { asSavedPath, FILE_SAVED, isAtOrUnder } from "../topics";

/**
 * This, `GIT_KIND_TOKEN` and `GIT_KIND_LETTER` restate `src/shell/contract.ts`'s
 * source-control panel exactly rather than importing it — see `rpc.ts`'s header
 * for why an app under `apps/` never reaches into `src/`. If the values here
 * drift from that file, that file is the one to trust; this is a copy, not a
 * second decision.
 */
export type GitChangeKind =
  "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

interface GitChange {
  /** Absolute, already resolved by the backend — matches `Entry.path`, so
   *  this can be looked up directly with no prefix-joining on this side. */
  path: string;
  kind: GitChangeKind;
  staged: boolean;
  /** Git named a whole directory rather than a file: everything under this
   *  path has the same status. See `absolute` in `files.rs`. */
  dir: boolean;
}

interface GitStatusResult {
  branch: string;
  changes: GitChange[];
}

/**
 * The colour token for each kind, matching VS Code's own convention: modified
 * and renamed read as "changed", added and untracked as "new", deleted as
 * "gone", conflicted as the error it is. Every value is one of the ten named
 * tokens in `src/tokens.css` — never a hex added here.
 */
export const GIT_KIND_TOKEN: Record<GitChangeKind, string> = {
  modified: "var(--warn)",
  added: "var(--ok)",
  deleted: "var(--err)",
  renamed: "var(--warn)",
  untracked: "var(--text-dim-3)",
  conflicted: "var(--err)",
};

/**
 * The single letter git itself prints in a status short-format. `untracked`
 * is `?` rather than `U` — `U` is already git's letter for an unmerged path,
 * and `conflicted` needs it more than a file nobody has added yet does.
 */
export const GIT_KIND_LETTER: Record<GitChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "U",
};

/**
 * Highest to lowest. A directory that holds more than one kind of change
 * below it can only tint its name one colour, so this decides which change a
 * reader gets pointed at first: a conflict always wins, and an untracked file
 * is the least alarming thing a folder can contain.
 */
const KIND_RANK: readonly GitChangeKind[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "added",
  "untracked",
];

/** A path git named as a whole directory, and what it said about it. */
interface Subtree {
  path: string;
  kind: GitChangeKind;
}

export interface GitDecoration {
  /** A path with a change of its own. */
  direct: ReadonlyMap<string, GitChangeKind>;
  /** A directory with no change of its own but a change *somewhere* below
   *  it, open or not. The value is the highest-ranked kind found in its
   *  subtree, which is what its tint shows. */
  rollup: ReadonlyMap<string, GitChangeKind>;
  /** Directories git collapsed into a single entry — in practice untracked
   *  ones. Everything at or under each is that kind. Scanned linearly per
   *  row, which is affordable because there are a handful of these and only
   *  the visible rows are ever rendered. */
  subtrees: readonly Subtree[];
  /** Ignored paths, mostly whole directories, from `files/git-ignored`. */
  ignored: readonly string[];
}

/** What one row draws. `kind` tints the name; `badge` is the letter, and is
 *  set only when the row's own path is what git named. */
export interface RowDecoration {
  kind?: GitChangeKind;
  badge?: GitChangeKind;
  ignored: boolean;
}

/** A row with nothing to say — shared rather than rebuilt, since the great
 *  majority of rows in any tree get exactly this. */
const PLAIN: RowDecoration = { ignored: false };

/**
 * How one row draws, given the whole decoration. The four rules, in the order
 * below, which is also the precedence between them:
 *
 * 1. A file git named gets its name tinted and a letter at the row's end.
 * 2. A directory with a change *below* it gets the tint and no letter. The
 *    letter is a statement about the row it sits on, and a folder has not
 *    itself been modified because something inside it was.
 * 3. Everything inside an untracked directory is untracked too — git collapses
 *    such a directory into one entry, but VS Code marks every file you find
 *    when you open it, so the collapsed entry is expanded here by prefix.
 * 4. An ignored path is greyed and says nothing else. It has no status to
 *    report: git is not tracking it.
 */
export function decorate(git: GitDecoration | null, path: string, isDir: boolean): RowDecoration {
  if (!git) return PLAIN;

  // First, because an ignored path has no status and must not pick one up
  // from a rollup either — `dist/` sitting under a folder full of edits is
  // still just ignored.
  if (git.ignored.some((root) => isAtOrUnder(path, root))) {
    return { ignored: true };
  }

  const direct = git.direct.get(path);
  if (direct) return { kind: direct, badge: direct, ignored: false };

  // Rule 3: inside a directory git named whole. A badge as well as a tint,
  // because this *is* the row's own status — it is only stated on an ancestor
  // because git had no reason to list every file separately.
  const subtree = git.subtrees.find((entry) => isAtOrUnder(path, entry.path));
  if (subtree) return { kind: subtree.kind, badge: subtree.kind, ignored: false };

  // Rule 2: a tint with no badge, and only ever for a directory.
  const rollup = isDir ? git.rollup.get(path) : undefined;
  return rollup ? { kind: rollup, ignored: false } : PLAIN;
}

/**
 * Fetch `files/git-status` and shape it for the tree.
 *
 * Refetches on mount and whenever `reloadNonce` changes — the same signal
 * `useTree` re-lists on, from the same refresh button, the same in-app create
 * and delete, and the same "the project changed underneath us" cases — and on
 * the three signals in the effect below, the times a status goes stale without
 * the tree changing at all. There is no push from the backend: like every other
 * read in this app, this is asked again rather than subscribed to.
 *
 * The ignore list is fetched on its own schedule — once per project — because
 * it costs around twenty times what a status does and answers a question that
 * only a `.gitignore` change affects. `git::ignored_roots` has the measurement.
 *
 * Resolves to `null` for "no project" or "not a repository" (what the RPC
 * itself returns) and also for a call that failed outright — both mean the
 * tree should draw exactly as it does with no git support at all, and a
 * caller checking one is checking the other for free.
 */
export function useGitStatus(rootPath: string | null, reloadNonce: number): GitDecoration | null {
  const [result, setResult] = useState<GitStatusResult | null>(null);
  const [ignored, setIgnored] = useState<readonly string[]>([]);
  const [pulse, setPulse] = useState(0);
  const [ignorePulse, setIgnorePulse] = useState(0);

  /**
   * The other three reasons a status goes stale, none of which touches the
   * tree and so none of which bumps `reloadNonce`. The commonest, a **save**,
   * is written on the subscription below.
   *
   * **Focus** and **visibility** cover everything that happened outside this
   * app entirely — a commit made in the shell's source control panel, a branch
   * switched in a terminal, an edit from another editor. Both events, for the
   * reason `useOpenFiles.ts` gives where it watches the same pair: this app is
   * an iframe, `focus` misses an alt-tab away and back when focus was
   * elsewhere in the shell, and `visibilitychange` misses a move between two
   * visible windows.
   *
   * This is not a file watcher, and the difference is visible: a change made
   * outside shows when you come back to the tree, not the instant it lands.
   * The refetch is cheap — around 50ms, and the ignore list is not part of it
   * — but it is still a `git status` per return, which is why it is tied to
   * coming back rather than to a timer.
   */
  useEffect(() => {
    const refresh = () => setPulse((n) => n + 1);
    const onVisible = () => {
      // Hiding is also a `visibilitychange`, and refetching for a pane nobody
      // is looking at is the one case this should skip.
      if (document.visibilityState === "visible") refresh();
    };

    // A save is the common reason a status goes stale: the file the user just
    // edited is exactly the row that should turn yellow, and nothing about the
    // tree's shape changed, so the Viewer says so directly rather than the
    // Explorer re-listing folders to find out.
    const stop = subscribe(FILE_SAVED, (value) => {
      refresh();
      // The one save that can change what is *greyed*. Everything else leaves
      // the ignore rules exactly as they were, and re-asking for them costs
      // around twenty times what this status refresh does — so the expensive
      // question is asked when its own answer can have changed, and not on
      // every save of every other file.
      const path = asSavedPath(value);
      if (path && baseName(path) === ".gitignore") setIgnorePulse((n) => n + 1);
    });
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    let live = true;
    void invoke<GitStatusResult | null>("files/git-status")
      .then((status) => {
        if (live) setResult(status);
      })
      .catch(() => {
        if (live) setResult(null);
      });
    return () => {
      live = false;
    };
  }, [reloadNonce, pulse]);

  // Cleared on a change of project rather than left standing: until the new
  // one answers, the previous project's ignore list would be greying rows it
  // knows nothing about. Deliberately keyed on the root alone and kept out of
  // the fetch below — a re-fetch after a `.gitignore` save is refreshing an
  // answer that is still true, and clearing it there would un-grey every
  // `node_modules` in the tree for as long as the refetch took.
  useEffect(() => setIgnored([]), [rootPath]);

  useEffect(() => {
    let live = true;
    if (!rootPath) return;

    void invoke<string[]>("files/git-ignored")
      .then((paths) => {
        if (live) setIgnored(paths);
      })
      .catch(() => {
        if (live) setIgnored([]);
      });
    return () => {
      live = false;
    };
  }, [rootPath, ignorePulse]);

  return useMemo(() => {
    if (!result) return null;

    const direct = new Map<string, GitChangeKind>();
    const subtrees: Subtree[] = [];
    // Unstaged entries land after staged ones in the backend's own array (see
    // `git_status` in `files.rs`), so setting every entry in order — letting
    // a later one overwrite an earlier one at the same key — leaves the more
    // recent change in place for a path that appears on both sides.
    for (const change of result.changes) {
      direct.set(change.path, change.kind);
      if (change.dir) subtrees.push({ path: change.path, kind: change.kind });
    }

    // Derived from the change paths themselves, not by walking the tree: most
    // of the tree is not loaded (it is lazy), and this has to work for a
    // directory nobody has opened yet.
    const rollup = new Map<string, GitChangeKind>();
    for (const change of result.changes) {
      let path = change.path;
      let cut = lastSeparator(path);
      while (cut > 0) {
        const dir = path.slice(0, cut);
        const current = rollup.get(dir);
        if (!current || rank(change.kind) < rank(current)) rollup.set(dir, change.kind);
        path = dir;
        cut = lastSeparator(path);
      }
    }

    return { direct, rollup, subtrees, ignored };
  }, [result, ignored]);
}

/** Both separators, exactly like `baseName` in `rpc.ts` — the backend returns
 *  whatever `Display` produced, which is backslash on Windows. */
function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
}

function rank(kind: GitChangeKind): number {
  return KIND_RANK.indexOf(kind);
}
