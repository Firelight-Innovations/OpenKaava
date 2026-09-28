/**
 * The environment model — display side only.
 *
 * `docs/KAAVA-UX-REWORK.md` §1-2 binds every cluster to one of four
 * environments: a local worktree, a cloud session, the standing
 * design-canvas worktree, or main itself, read-only. Rust only carries
 * `worktree`/`project` today, so [`environmentOf`] turns those two into the
 * four-way kind the boards draw — every caller goes through it rather than
 * `cluster.worktree` directly, so only it need change once **clusters** lands
 * a real `environment` field. `cloud` is typed and unreachable today, but not
 * a guess: the spec's `job-7f3a`/`agent/anom-142` fields are exactly
 * `branch`, `base` and `path`'s cloud-side counterparts.
 */
import type { Cluster } from "./contract";

export type EnvironmentKind = "worktree" | "cloud" | "main" | "design";

export interface Environment {
  kind: EnvironmentKind;
  /** The checked-out branch. Absent for `main`, which is read-only and has
   *  none of its own. */
  branch?: string;
  /** What it forked from, as `main@<hash>`. No source populates this yet
   *  (see `WorktreeControl.divergence`); a caller may merge it in. */
  base?: string;
  /** On-disk path, for a worktree or the design canvas's standing one. */
  path?: string;
  /** Commits ahead/behind `base` — omitted rather than `0`, which would
   *  claim a worktree is caught up when nothing has measured that. */
  ahead?: number;
  behind?: number;
}

/**
 * The standing design-canvas worktree's branch (§5). `Cluster` has no
 * `pinned` flag yet, so until the **clusters** workstream adds one, this is
 * the one thing [`environmentOf`] can check against real data.
 */
export const DESIGN_WORKTREE_BRANCH = "wt/design";

/** A cluster's environment: a worktree on `wt/design` reads as `design`, any
 *  other worktree as `worktree`, and none at all as `main` (read-only). */
export function environmentOf(cluster: Cluster): Environment {
  const worktree = cluster.worktree;
  if (worktree === null) return { kind: "main" };

  const kind: EnvironmentKind = worktree.branch === DESIGN_WORKTREE_BRANCH ? "design" : "worktree";
  return {
    kind,
    ...(worktree.branch !== null && { branch: worktree.branch }),
    path: worktree.path,
  };
}

/** A stable key for "same environment as that one", used to count distinct
 *  environments in the title bar's `· N environments` segment. A worktree
 *  path dedupes two clusters onto one (§2.1) — a branch alone would not. */
export function environmentKey(env: Environment): string {
  if (env.kind === "main") return "main";
  return `${env.kind}:${env.path ?? env.branch ?? ""}`;
}

/** The kind chip's label, shared by the cluster tab's chip and the
 *  environment bar's kind chip so the two never drift apart. */
export const ENVIRONMENT_LABEL: Record<EnvironmentKind, string> = {
  worktree: "wt",
  cloud: "cloud",
  main: "main",
  design: "design",
};

/** The environment bar's longer form of the same label. */
export const ENVIRONMENT_BAR_LABEL: Record<EnvironmentKind, string> = {
  worktree: "Local worktree",
  cloud: "Cloud session",
  main: "Main",
  design: "Design canvas",
};
