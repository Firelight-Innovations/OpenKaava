/**
 * Which environment a cluster is working in, and whether two clusters share one.
 *
 * A minimal stand-in for the `chrome` workstream's own file of the same name
 * and the same signature (see `docs/KAAVA-UX-REWORK.md` §2 for the model this
 * is a first slice of: a cluster is bound to exactly one environment — a local
 * worktree, a cloud session, or main). Nothing in the backend models a cloud
 * session yet, so the only environment this can actually answer for today is
 * "which checkout on disk" — the same precedence `clusterRoot` already
 * resolves. If `chrome` lands its own copy first, the two are meant to be
 * identical and the integrator keeps one.
 *
 * A shared leaf module, per STANDARDS.md §1.2 (a region may import
 * `contract.ts` and the shared leaf modules directly under `src/shell/`,
 * nothing else): this is one of those leaves.
 */
import { clusterRoot, type Cluster } from "./contract";

/**
 * The environment a cluster is bound to, as an opaque id two clusters can be
 * compared by. `null` for a cluster pointed at nothing yet — Home's
 * pick-a-project state — which is not the same environment as any other
 * cluster in that state; see `sameEnvironment`.
 *
 * Today this is exactly `clusterRoot`: the worktree path a cluster is
 * checked out into, or its project folder when it has no worktree of its
 * own. A cloud session has no representation yet — `Cluster.worktree` is
 * `Option<WorktreeRef>` and nothing populates a VM checkout into it — so a
 * cloud cluster reads as `null` here rather than as a distinct kind, which is
 * an honest gap rather than a guess: see KAAVA-UX-REWORK.md §9.2.
 */
export function environmentOf(cluster: Cluster): string | null {
  return clusterRoot(cluster);
}

/**
 * Whether a tab dragged out of `from` may land in `to` — the gate
 * KAAVA-UX-REWORK.md §5 states plainly: "Tabs can only move between clusters
 * that share an environment."
 *
 * Two clusters with no environment at all (both mid pick-a-project) are
 * **not** the same environment — `null` is "nowhere yet," and nowhere is not
 * a place two clusters can share. Refusing this rather than allowing it is
 * the safer default: an empty cluster is the one a person is about to point
 * at a *different* project, and letting a tab drop into it first would move
 * a real file into a checkout that has not been chosen yet.
 */
export function sameEnvironment(from: Cluster | null, to: Cluster | null): boolean {
  if (!from || !to) return false;
  const a = environmentOf(from);
  const b = environmentOf(to);
  return a !== null && a === b;
}
