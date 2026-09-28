/**
 * The environment model — display side only. Every cluster is exactly one of
 * a local worktree, a cloud session, the standing design-canvas worktree, or
 * main itself, read-only (`docs/KAAVA-UX-REWORK.md` §1-2). [`environmentOf`]
 * reads `Cluster.environment` when the backend has set it, falling back to
 * the older `worktree`/`project` fields for a cluster that predates it.
 * Every caller goes through it rather than either field directly.
 *
 * This file's `Environment` is a display type, not `bindings.Environment`
 * re-exported — it adds `ahead`/`behind` divergence nothing on the wire fills
 * in yet, and a cloud session's `sessionId`/`vm` for the environment bar.
 */
import type { Cluster } from "./contract";
import type { Environment as RustEnvironment } from "../bindings";

export type EnvironmentKind = "worktree" | "cloud" | "main" | "design";

export interface Environment {
  kind: EnvironmentKind;
  /** The checked-out branch. Absent for `main`, which has none to show — it
   *  is read-only in Kaava by definition, not on a branch of its own. */
  branch?: string;
  /** What the environment forked from, as `main@<hash>`. No source populates
   *  this yet (see `WorktreeControl.divergence` in `contract.ts`); a caller
   *  that has fetched the divergence separately may merge it in. */
  base?: string;
  /** On-disk path, for a worktree or the design canvas's standing one. */
  path?: string;
  /** Commits ahead of / behind `base`. Also nobody's to fill in yet — see
   *  `base` above. Omitted rather than `0`, which would claim a worktree is
   *  caught up when nothing has actually measured that. */
  ahead?: number;
  behind?: number;
  /** A cloud session's id and VM name (`RustEnvironment`'s `cloud` variant).
   *  Absent for every other kind. */
  sessionId?: string;
  vm?: string;
}

/**
 * `cluster.environment`'s kind names, translated to this file's own —
 * `localWorktree` is this model's plain `worktree`; the rest already agree.
 * Kept as one table rather than inlined in [`environmentOf`] so the mapping
 * cannot silently drift if either enum grows a variant the other does not.
 */
function fromRustEnvironment(env: RustEnvironment): Environment {
  switch (env.kind) {
    case "localWorktree":
      return { kind: "worktree", branch: env.branch, base: env.base, path: env.path };
    case "cloud":
      return {
        kind: "cloud",
        sessionId: env.sessionId,
        vm: env.vm,
        ...(env.branch !== null && { branch: env.branch }),
      };
    case "main":
      return { kind: "main" };
    case "design":
      return { kind: "design", branch: env.branch, path: env.path };
  }
}

/**
 * The branch name of the standing design-canvas worktree
 * (`docs/KAAVA-UX-REWORK.md` §5) — a worktree checked out to exactly this
 * branch is the design canvas, independent of `Cluster.pinned`.
 */
export const DESIGN_WORKTREE_BRANCH = "wt/design";

/**
 * A cluster's environment. `cluster.environment` (see the file header) wins
 * when the backend has set it. Otherwise this falls back to the legacy
 * derivation from `worktree`: a worktree on `wt/design` reads as `design`;
 * any other worktree reads as `worktree`; a cluster with no worktree at all
 * is working directly in the project folder, which this model calls `main`
 * — read-only, per the written spec's "nobody works on main" rule. `cloud`
 * cannot come out of the fallback path — nothing in the legacy fields names
 * a cloud session — only out of a real `cluster.environment`.
 */
export function environmentOf(cluster: Cluster): Environment {
  if (cluster.environment) return fromRustEnvironment(cluster.environment);

  const worktree = cluster.worktree;
  if (worktree === null) return { kind: "main" };

  const kind: EnvironmentKind = worktree.branch === DESIGN_WORKTREE_BRANCH ? "design" : "worktree";
  return {
    kind,
    ...(worktree.branch !== null && { branch: worktree.branch }),
    path: worktree.path,
  };
}

/**
 * A stable key for "is this the same environment as that one", used to count
 * distinct environments in the title bar's `· N environments` segment. Two
 * clusters can share one environment (`docs/KAAVA-UX-REWORK.md` §2.1's
 * "an existing environment"), and a plain worktree path is the one field that
 * is both stable and unique enough to dedupe on — a branch alone is not,
 * since `checkout` can point two worktrees' clusters at the same name only in
 * the git-error sense that never actually happens in practice, but a path
 * never collides.
 */
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
