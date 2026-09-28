/**
 * The environment model — display side only. `docs/KAAVA-UX-REWORK.md` §1-2
 * binds every cluster to one of four environments: a local worktree, a cloud
 * session, the standing design-canvas worktree, or main itself, read-only.
 * Rust only carries `worktree`/`project` today; every caller goes through
 * [`environmentOf`], never `cluster.worktree` directly, so the day the
 * **clusters** workstream lands a real `environment` field, only this
 * function's body changes — signature and exports stay put.
 *
 * `cloud` is fully typed and unreachable today — nothing in `Cluster` names
 * a session — but its fields (`branch`/`base`/`path`) already match the
 * written spec's `job-7f3a`/`agent/anom-142` shape, so a real cloud cluster
 * slots in without widening the type.
 */
import type { Cluster } from "./contract";

export type EnvironmentKind = "worktree" | "cloud" | "main" | "design";

export interface Environment {
  kind: EnvironmentKind;
  /** Absent for `main`, which has no branch of its own. */
  branch?: string;
  /** `main@<hash>`. No source populates this yet; a caller with the
   *  divergence separately may merge it in. */
  base?: string;
  /** On-disk path, for a worktree or the design canvas. */
  path?: string;
  /** Commits ahead of / behind `base`. Omitted, not `0` — nothing has
   *  measured it yet. */
  ahead?: number;
  behind?: number;
}

/** The standing design-canvas worktree's branch (§5) — the one real signal
 *  [`environmentOf`] can check until `Cluster` carries its own `pinned`
 *  flag. */
export const DESIGN_WORKTREE_BRANCH = "wt/design";

/**
 * A cluster's environment, derived from the fields Rust already sends: a
 * worktree on `wt/design` reads as `design`, any other worktree as
 * `worktree`, no worktree at all as `main` (read-only, per the "nobody
 * works on main" rule). `cloud` never comes out of this function today.
 */
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

/** A stable key for "same environment as that one" — used to count distinct
 *  environments in the title bar's `· N environments` segment. A worktree
 *  path, not a branch, since a branch name is not guaranteed unique. */
export function environmentKey(env: Environment): string {
  if (env.kind === "main") return "main";
  return `${env.kind}:${env.path ?? env.branch ?? ""}`;
}

/** The kind chip's label, shared by the cluster tab and the environment bar. */
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
