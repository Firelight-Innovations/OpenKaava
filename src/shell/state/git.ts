/**
 * The frontend half of source control.
 *
 * Mirrors `src-tauri/src/git.rs`. One-shot calls and no subscription: there is
 * no filesystem watcher behind this, so nothing here can push. The panel re-asks
 * after every mutation, and that is the entire update model — deliberately
 * unlike `shellState.ts`, where several windows must agree so Rust broadcasts.
 *
 * Two interfaces, split by *subject* rather than by scope — both take a cluster
 * id. `gitControl` is the index: what has changed, what is staged, commit it.
 * `worktreeControl` is the checkout a cluster has been given of its own: which
 * worktrees exist, the repository's history, how far this one has diverged.
 * Ids rather than paths in both, and for the same reason: resolving one to a
 * directory is Rust's job, which keeps checkout paths out of the interface
 * entirely — `contract.ts` says the shell never learns one, and this is where
 * that would otherwise leak.
 *
 * `gitControl` took a *tool* id until that was found to fail for every project,
 * for reasons the note on `git_cluster_status` in `git.rs` tells in full.
 */
import {
  gitBranches,
  gitCheckout,
  gitClusterCommit,
  gitClusterDiff,
  gitClusterStage,
  gitClusterStatus,
  gitClusterUnstage,
  gitDivergence,
  gitDivergenceDiff,
  gitGraph,
  gitWorktreeCreate,
  gitWorktreeReconcile,
  gitWorktreeRemove,
  gitWorktrees,
} from "../../bindings";
import type { GitControl, WorktreeControl } from "../contract";

export const gitControl: GitControl = {
  status(clusterId) {
    // Rust answers `Option<GitStatus>`, which arrives as the value or `null`.
    // No mapping needed — `null` already means "no repo here, draw the empty
    // state".
    return gitClusterStatus(clusterId);
  },

  diff(clusterId, path, staged) {
    return gitClusterDiff(clusterId, path, staged);
  },

  stage(clusterId, paths) {
    return gitClusterStage(clusterId, paths);
  },

  unstage(clusterId, paths) {
    return gitClusterUnstage(clusterId, paths);
  },

  commit(clusterId, message) {
    return gitClusterCommit(clusterId, message);
  },
};

/**
 * The frontend half of a cluster's own checkout.
 *
 * Separate from `gitControl` above, split by scope rather than subject: that one
 * answers about the index, these about the *cluster* that can be moved onto a
 * worktree. Apart, neither interface carries an id whose meaning depends on
 * which method you called.
 *
 * Thin by design — every one goes straight to a binding, because the decisions
 * worth making (where a worktree is placed, whether a name is usable, whether a
 * binding still points at anything) are Rust's, where the filesystem is. A
 * frontend that recomputed one would be a second answer that could disagree.
 */
export const worktreeControl: WorktreeControl = {
  list(clusterId) {
    return gitWorktrees(clusterId);
  },

  graph(clusterId, limit) {
    return gitGraph(clusterId, limit);
  },

  branches(clusterId) {
    return gitBranches(clusterId);
  },

  checkout(clusterId, target, detach) {
    return gitCheckout(clusterId, target, detach);
  },

  divergence(clusterId) {
    return gitDivergence(clusterId);
  },

  divergenceDiff(clusterId, path, mergeBase) {
    return gitDivergenceDiff(clusterId, path, mergeBase);
  },

  create(clusterId, name) {
    return gitWorktreeCreate(clusterId, name);
  },

  remove(clusterId, force) {
    return gitWorktreeRemove(clusterId, force);
  },
};

/**
 * Drop a cluster's worktree binding when the checkout behind it has been
 * deleted from outside Veistra.
 *
 * Not on `WorktreeControl` because it is not something a user does — it is
 * housekeeping the shell runs on a cluster switch, and putting it on the
 * interface would invite a component to call it as though it were an action.
 * The backend clears the binding and broadcasts `shell:state`, so the return
 * value is only for a caller unwilling to wait for the round trip.
 */
export function reconcileWorktree(clusterId: string) {
  return gitWorktreeReconcile(clusterId);
}
