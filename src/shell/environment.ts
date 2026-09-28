/**
 * The environment model — display side only.
 *
 * The written spec (`docs/KAAVA-UX-REWORK.md` §1-2) binds every cluster to
 * exactly one environment: a local worktree, a cloud session, the standing
 * design-canvas worktree, or main itself, read-only. Rust does not carry that
 * distinction yet — a `Cluster` has only `worktree` and `project` — so this
 * file is the one place that turns today's two fields into the four-way kind
 * the boards draw, which is what keeps the swap small the day the **clusters**
 * workstream lands a real `environment` field on `Cluster`: every caller in
 * this workstream goes through [`environmentOf`], not through `cluster.worktree`
 * directly, so only this function needs to change.
 *
 * `cloud` is fully typed here and unreachable today: nothing in `Cluster`
 * names a cloud session, so [`environmentOf`] never returns it. It is not a
 * guess at a future shape — the written spec's `job-7f3a` / `agent/anom-142`
 * fields are exactly `branch`, `base` and `path`'s cloud-side counterparts,
 * so a real cloud cluster slots into this type without widening it.
 */
import type { Cluster } from "./contract";

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
}

/**
 * The branch name of the standing design-canvas worktree
 * (`docs/KAAVA-UX-REWORK.md` §5). `Cluster` carries no `pinned` flag yet — the
 * **clusters** workstream adds one, and a pinned cluster's own field will be
 * the honest signal once it exists — so until then this is the one thing
 * [`environmentOf`] can check against real data: a worktree checked out to
 * exactly this branch is the design canvas.
 */
export const DESIGN_WORKTREE_BRANCH = "wt/design";

/**
 * A cluster's environment, derived from the fields Rust already sends.
 *
 * Precedence: a worktree on `wt/design` reads as `design`; any other worktree
 * reads as `worktree`; a cluster with no worktree at all is working directly
 * in the project folder, which this model calls `main` — read-only, per the
 * written spec's "nobody works on main" rule. `cloud` never comes out of this
 * function today; see the file header.
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
